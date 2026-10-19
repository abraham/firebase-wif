import { FirebaseWifError } from './errors.js';
import {
  desiredAttributeCondition,
  desiredAttributeMapping,
  ISSUER,
  MANAGED_MARKER,
  managedDescription,
  REQUIRED_MAPPING_KEYS,
  serviceAccountProject,
} from './naming.js';
import { addMember, analyzeCondition, hasMember, removeMember, rolesOf, type Policy } from './policy.js';
import {
  CRM,
  IAM,
  poolId,
  providerId,
  read,
  readPool,
  readProjectPolicy,
  readProvider,
  readServiceAccount,
  readServiceAccountPolicy,
  readServices,
  repoPrincipal,
  SERVICE_USAGE,
  type Read,
  type Runtime,
} from './runtime.js';
import { SERVICE_ACCOUNT_USER_ROLE } from '../presets.js';
import type { Change, ChangeAction } from './types.js';
import { updatePolicy, waitForOperation, type Operation, type Writer } from './writes.js';

export type Outcome =
  | { kind: 'ok'; message: string }
  | { kind: 'drift'; message: string; changes: Change[]; fix?: string }
  | { kind: 'skipped'; message: string; changes?: Change[] }
  | { kind: 'blocked'; message: string; fix: string; error: FirebaseWifError };

/** A resource `setup` reconciles; its check fails exactly when its plan has changes. */
export interface Resource {
  id: string;
  severity: 'fail' | 'warn';
  /** `project` resources are reconciled in every project; `trust-chain` ones only in the home project. */
  scope: 'project' | 'trust-chain';
  evaluate(rt: Runtime): Promise<Outcome>;
  /** Makes the non-manual changes `evaluate` reported, re-reading through the same fresh runtime. */
  apply(rt: Runtime, w: Writer): Promise<void>;
}

const change = (resource: string, action: ChangeAction, description: string, manual = false): Change =>
  manual ? { resource, action, description, manual } : { resource, action, description };

const drift = (changes: Change[], fix?: string): Outcome => ({
  kind: 'drift',
  message: changes.map((c) => c.description).join('; '),
  changes,
  ...(fix ? { fix } : {}),
});

const WORKLOAD_IDENTITY_USER = 'roles/iam.workloadIdentityUser';
const ADMIN_FIX = 'Ask a repo admin to run firebase-wif setup, or make these changes by hand.';

/** A policy change that grants `role` to `member`, or nothing when it's already granted. */
const grant = (role: string, member: string) => (policy: Policy) => {
  const next = addMember(policy, role, member);
  return next === policy ? undefined : next;
};

const isManaged = async (rt: Runtime): Promise<boolean> => {
  const account = await readServiceAccount(rt);
  return account.kind === 'found' && Boolean(account.value.description?.includes(MANAGED_MARKER));
};

/** Roles `--prune` removes: unconditional, unrequested, and only from a managed service account. */
const prunable = async (rt: Runtime, policy: Read<Policy>): Promise<string[]> => {
  if (!rt.prune || policy.kind !== 'found') return [];
  const extra = rolesOf(policy.value, `serviceAccount:${rt.ctx.serviceAccount}`).filter(
    (role) => !rt.ctx.roles.includes(role),
  );
  return extra.length && (await isManaged(rt)) ? extra : [];
};

const apis: Resource = {
  id: 'gcp.apis',
  severity: 'fail',
  scope: 'project',
  async evaluate(rt) {
    const services = await readServices(rt);
    if (services.kind !== 'found')
      return { kind: 'skipped', message: services.kind === 'skipped' ? services.reason : 'unknown' };
    const disabled = [...services.value].filter(([, on]) => !on).map(([api]) => api);
    if (!disabled.length) return { kind: 'ok', message: `${services.value.size}/${services.value.size} enabled` };
    return drift([change(this.id, 'enable', `enable ${disabled.join(', ')}`)]);
  },
  async apply(rt, w) {
    const services = await readServices(rt);
    if (services.kind !== 'found') return;
    const serviceIds = [...services.value].filter(([, on]) => !on).map(([api]) => api);
    const operation = await rt.google.request<Operation>(
      'POST',
      `${SERVICE_USAGE}/projects/${rt.ctx.projectNumber}/services:batchEnable`,
      { serviceIds },
    );
    await waitForOperation(w, rt.google, SERVICE_USAGE, operation, `enable ${serviceIds.join(', ')}`);
  },
};

const pool: Resource = {
  id: 'gcp.pool',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const id = poolId(rt.ctx);
    const current = await readPool(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift([change(this.id, 'create', `create workload identity pool ${id}`)]);
    if (current.value.state === 'DELETED') {
      return drift([change(this.id, 'undelete', `restore deleted workload identity pool ${id}`)]);
    }
    if (current.value.disabled) return drift([change(this.id, 'update', `re-enable workload identity pool ${id}`)]);
    return { kind: 'ok', message: `${id} is active` };
  },
  async apply(rt, w) {
    const id = poolId(rt.ctx);
    const current = await readPool(rt);
    let operation: Operation;
    if (current.kind === 'missing') {
      operation = await rt.google.request<Operation>(
        'POST',
        `${IAM}/projects/${rt.ctx.projectNumber}/locations/global/workloadIdentityPools?workloadIdentityPoolId=${id}`,
        { displayName: 'GitHub Actions', description: 'Created by firebase-wif' },
      );
    } else if (current.kind === 'found' && current.value.state === 'DELETED') {
      operation = await rt.google.request<Operation>('POST', `${IAM}/${rt.ctx.pool}:undelete`, {});
    } else if (current.kind === 'found' && current.value.disabled) {
      operation = await rt.google.request<Operation>('PATCH', `${IAM}/${rt.ctx.pool}?updateMask=disabled`, {
        disabled: false,
      });
    } else {
      return;
    }
    await waitForOperation(w, rt.google, IAM, operation, `set up workload identity pool ${id}`);
  },
};

const provider: Resource = {
  id: 'gcp.provider',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const id = providerId(rt.ctx);
    const parent = await readPool(rt);
    if (parent.kind === 'skipped') return { kind: 'skipped', message: parent.reason };
    if (parent.kind === 'missing') return drift([change(this.id, 'create', `create provider ${id}`)]);

    const current = await readProvider(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift([change(this.id, 'create', `create provider ${id}`)]);

    const value = current.value;
    if (value.state === 'DELETED') return drift([change(this.id, 'undelete', `restore deleted provider ${id}`)]);
    if (value.oidc?.issuerUri !== ISSUER) {
      const message = `Provider ${id} uses issuer ${value.oidc?.issuerUri ?? '(none)'}, not GitHub Actions.`;
      const fix = 'Pass --provider with a different provider ID.';
      return {
        kind: 'blocked',
        message,
        fix,
        error: new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', message, { fix }),
      };
    }
    const changes: Change[] = [];
    if (value.disabled) changes.push(change(this.id, 'update', `re-enable provider ${id}`));
    const desired = desiredAttributeMapping();
    const missing = REQUIRED_MAPPING_KEYS.filter((key) => value.attributeMapping?.[key] !== desired[key]);
    if (missing.length) changes.push(change(this.id, 'update', `map ${missing.join(', ')} on provider ${id}`));
    return changes.length ? drift(changes) : { kind: 'ok', message: `${id} trusts ${ISSUER}` };
  },
  async apply(rt, w) {
    const id = providerId(rt.ctx);
    const current = await readProvider(rt);
    let operation: Operation;
    if (current.kind === 'missing') {
      operation = await createProvider(rt, id);
    } else if (current.kind === 'found' && current.value.state === 'DELETED') {
      operation = await rt.google.request<Operation>('POST', `${IAM}/${rt.ctx.provider}:undelete`, {});
    } else if (current.kind === 'found') {
      const mask: string[] = [];
      const body: Record<string, unknown> = {};
      if (current.value.disabled) {
        mask.push('disabled');
        body.disabled = false;
      }
      const desired = desiredAttributeMapping();
      const mapping = { ...current.value.attributeMapping };
      const missing = REQUIRED_MAPPING_KEYS.filter((key) => mapping[key] !== desired[key]);
      if (missing.length) {
        for (const key of missing) mapping[key] = desired[key]!;
        mask.push('attributeMapping');
        body.attributeMapping = mapping;
      }
      if (!mask.length) return;
      operation = await rt.google.request<Operation>(
        'PATCH',
        `${IAM}/${rt.ctx.provider}?updateMask=${mask.join(',')}`,
        body,
      );
    } else {
      return;
    }
    await waitForOperation(w, rt.google, IAM, operation, `set up provider ${id}`);
  },
};

const createProvider = async (rt: Runtime, id: string): Promise<Operation> => {
  const { pool, repo, repoId, ownerId } = rt.ctx;
  try {
    return await rt.google.request<Operation>('POST', `${IAM}/${pool}/providers?workloadIdentityPoolProviderId=${id}`, {
      displayName: `GitHub ${repo}`.slice(0, 32),
      description: managedDescription(repo, repoId),
      attributeMapping: desiredAttributeMapping(),
      attributeCondition: desiredAttributeCondition(repoId, ownerId),
      oidc: { issuerUri: ISSUER },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('constraints/iam.workloadIdentityPoolProviders')) {
      throw new FirebaseWifError(
        'ORG_POLICY_BLOCKS_ISSUER',
        "The organization policy constraints/iam.workloadIdentityPoolProviders doesn't allow GitHub Actions as an issuer.",
        { fix: `Ask an organization policy admin to add ${ISSUER} to the constraint's allowed values.` },
      );
    }
    throw error;
  }
};

const providerCondition: Resource = {
  id: 'gcp.provider-condition',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const id = providerId(rt.ctx);
    const current = await readProvider(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing' || current.value.state === 'DELETED') {
      return { kind: 'skipped', message: `provider ${id} doesn't exist yet` };
    }
    const { repo, repoId } = rt.ctx;
    const analysis = analyzeCondition(current.value.attributeCondition, repoId, repo);
    switch (analysis.kind) {
      case 'pinned':
        return { kind: 'ok', message: `only accepts ${repo} (id ${repoId})` };
      case 'other-repo': {
        const message = `Provider ${id} trusts another repository (${analysis.other}).`;
        const fix = "Pass --provider with a different provider ID; never re-point another repo's provider.";
        return {
          kind: 'blocked',
          message,
          fix,
          error: new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', message, { fix }),
        };
      }
      case 'missing':
        return drift([change(this.id, 'update', `limit provider ${id} to ${repo} (no attribute condition)`)]);
      case 'name-only':
        return drift([
          change(this.id, 'update', `pin provider ${id} to repository ID ${repoId} instead of the name ${repo}`),
        ]);
      case 'loose':
        return drift([
          change(this.id, 'update', `limit provider ${id} to ${repo} (condition doesn't pin a repository ID)`),
        ]);
    }
  },
  async apply(rt, w) {
    const operation = await rt.google.request<Operation>(
      'PATCH',
      `${IAM}/${rt.ctx.provider}?updateMask=attributeCondition`,
      {
        attributeCondition: desiredAttributeCondition(rt.ctx.repoId, rt.ctx.ownerId),
      },
    );
    await waitForOperation(w, rt.google, IAM, operation, `limit provider ${providerId(rt.ctx)} to ${rt.ctx.repo}`);
  },
};

const serviceAccount: Resource = {
  id: 'gcp.service-account',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const email = rt.ctx.serviceAccount;
    const current = await readServiceAccount(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift([change(this.id, 'create', `create service account ${email}`)]);
    if (current.value.disabled) return drift([change(this.id, 'enable', `enable service account ${email}`)]);
    return { kind: 'ok', message: `${email} exists` };
  },
  async apply(rt, w) {
    const { serviceAccount: email, repo, repoId, projectId } = rt.ctx;
    const current = await readServiceAccount(rt);
    if (current.kind === 'missing') {
      await rt.google.request('POST', `${IAM}/projects/${serviceAccountProject(email) ?? projectId}/serviceAccounts`, {
        accountId: email.split('@')[0],
        serviceAccount: {
          displayName: `GitHub Actions: ${repo}`.slice(0, 100),
          description: managedDescription(repo, repoId),
        },
      });
      w.createdServiceAccount = true;
    } else if (current.kind === 'found' && current.value.disabled) {
      await rt.google.request('POST', `${IAM}/projects/-/serviceAccounts/${email}:enable`, {});
    }
  },
};

const projectRoles: Resource = {
  id: 'gcp.project-roles',
  severity: 'fail',
  scope: 'project',
  async evaluate(rt) {
    const { serviceAccount: email, roles, projectId } = rt.ctx;
    const policy = await readProjectPolicy(rt);
    if (policy.kind === 'skipped') return { kind: 'skipped', message: policy.reason };
    const member = `serviceAccount:${email}`;
    const missing = policy.kind === 'found' ? roles.filter((role) => !hasMember(policy.value, role, member)) : roles;
    const extra = await prunable(rt, policy);
    const changes = [
      ...missing.map((role) => change(this.id, 'bind', `grant ${role} on ${projectId} to ${email}`)),
      ...extra.map((role) => change(this.id, 'unbind', `remove ${role} on ${projectId} from ${email}`)),
    ];
    if (!changes.length)
      return { kind: 'ok', message: `${roles.length} role${roles.length === 1 ? '' : 's'} on ${projectId}` };
    return drift(changes);
  },
  async apply(rt, w) {
    const { serviceAccount: email, roles, projectId } = rt.ctx;
    const member = `serviceAccount:${email}`;
    const prune = rt.prune && (await isManaged(rt));
    await updatePolicy(w, rt.google, {
      resource: `${CRM}/projects/${projectId}`,
      getBody: { options: { requestedPolicyVersion: 3 } },
      label: `update the IAM policy of ${projectId}`,
      change: (policy) => {
        let next = policy;
        for (const role of roles) next = addMember(next, role, member);
        if (prune) {
          for (const role of rolesOf(next, member)) if (!roles.includes(role)) next = removeMember(next, role, member);
        }
        return next === policy ? undefined : next;
      },
    });
  },
};

const workloadIdentityUser: Resource = {
  id: 'gcp.wi-user',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const { serviceAccount: email, repo } = rt.ctx;
    const principal = repoPrincipal(rt.ctx);
    const bind = [change(this.id, 'bind', `let ${repo} act as ${email} (${WORKLOAD_IDENTITY_USER})`)];

    const account = await readServiceAccount(rt);
    if (account.kind === 'skipped') return { kind: 'skipped', message: account.reason };
    if (account.kind === 'missing') return drift(bind);

    const policy = await readServiceAccountPolicy(rt, email);
    if (policy.kind === 'skipped') return { kind: 'skipped', message: policy.reason };
    if (policy.kind === 'found' && hasMember(policy.value, WORKLOAD_IDENTITY_USER, principal)) {
      return { kind: 'ok', message: `${repo} can act as ${email}` };
    }
    return drift(bind);
  },
  async apply(rt, w) {
    const { serviceAccount: email } = rt.ctx;
    await updatePolicy(w, rt.google, {
      resource: `${IAM}/projects/-/serviceAccounts/${email}`,
      label: `update the IAM policy of ${email}`,
      change: grant(WORKLOAD_IDENTITY_USER, repoPrincipal(rt.ctx)),
    });
  },
};

const runtimeServiceAccountUser: Resource = {
  id: 'gcp.runtime-sa-user',
  severity: 'fail',
  scope: 'project',
  async evaluate(rt) {
    const { serviceAccount: email, runtimeServiceAccounts } = rt.ctx;
    if (!runtimeServiceAccounts.length) return { kind: 'skipped', message: 'no functions preset' };
    const member = `serviceAccount:${email}`;
    const changes: Change[] = [];
    const notes: string[] = [];
    for (const runtime of runtimeServiceAccounts) {
      const policy = await readServiceAccountPolicy(rt, runtime);
      if (policy.kind === 'skipped') return { kind: 'skipped', message: policy.reason };
      if (policy.kind === 'missing') {
        notes.push(`${runtime} doesn't exist yet`);
        continue;
      }
      if (!hasMember(policy.value, SERVICE_ACCOUNT_USER_ROLE, member)) {
        changes.push(change(this.id, 'bind', `let ${email} act as runtime ${runtime} (${SERVICE_ACCOUNT_USER_ROLE})`));
      }
    }
    if (changes.length) return drift(changes);
    if (notes.length) return { kind: 'skipped', message: notes.join('; ') };
    return { kind: 'ok', message: `${email} can act as ${runtimeServiceAccounts.join(', ')}` };
  },
  async apply(rt, w) {
    const member = `serviceAccount:${rt.ctx.serviceAccount}`;
    for (const runtime of rt.ctx.runtimeServiceAccounts) {
      const policy = await readServiceAccountPolicy(rt, runtime);
      if (policy.kind !== 'found' || hasMember(policy.value, SERVICE_ACCOUNT_USER_ROLE, member)) continue;
      await updatePolicy(w, rt.google, {
        resource: `${IAM}/projects/-/serviceAccounts/${runtime}`,
        label: `update the IAM policy of ${runtime}`,
        change: grant(SERVICE_ACCOUNT_USER_ROLE, member),
      });
    }
  },
};

const expectedVariables = (rt: Runtime): [name: string, value: string][] =>
  rt.ctx.variables
    ? [
        [rt.ctx.variables.provider, rt.ctx.provider],
        [rt.ctx.variables.serviceAccount, rt.ctx.serviceAccount],
      ]
    : [];

const variables: Resource = {
  id: 'gh.variables',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const names = rt.ctx.variables;
    if (!names) return { kind: 'skipped', message: 'repo variables disabled' };
    const expected = expectedVariables(rt);
    if (!rt.github) {
      return {
        kind: 'skipped',
        message: 'no GitHub credentials',
        changes: expected.map(([name, value]) => change(this.id, 'set', `set repo variable ${name} to ${value}`, true)),
      };
    }
    const manual = rt.preflight.githubAdmin === false;
    const changes: Change[] = [];
    for (const [name, value] of expected) {
      const current = rt.variableValues.get(name) ?? { kind: 'skipped', reason: 'not read' };
      if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
      if (current.kind === 'missing' || current.value !== value) {
        changes.push(change(this.id, 'set', `set repo variable ${name} to ${value}`, manual));
      }
    }
    if (!changes.length) return { kind: 'ok', message: `${names.provider} and ${names.serviceAccount} match` };
    return drift(changes, manual ? ADMIN_FIX : undefined);
  },
  async apply(rt) {
    const github = rt.github;
    if (!github) return;
    for (const [name, value] of expectedVariables(rt)) {
      const current = rt.variableValues.get(name);
      if (current?.kind === 'missing') {
        await github.request('POST', `/repos/${rt.ctx.repo}/actions/variables`, { name, value });
      } else if (current?.kind === 'found' && current.value !== value) {
        await github.request('PATCH', `/repos/${rt.ctx.repo}/actions/variables/${name}`, { name, value });
      }
    }
  },
};

interface Environment {
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
  protection_rules?: {
    type?: string;
    wait_timer?: number;
    prevent_self_review?: boolean;
    reviewers?: { type?: string; reviewer?: { id?: number } }[];
  }[];
}

/** GitHub's environment PUT drops protection rules it isn't sent, so send the current ones back. */
const currentProtection = (env: Environment): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  for (const rule of env.protection_rules ?? []) {
    if (rule.type === 'wait_timer' && rule.wait_timer !== undefined) fields.wait_timer = rule.wait_timer;
    if (rule.type === 'required_reviewers') {
      fields.prevent_self_review = rule.prevent_self_review ?? false;
      fields.reviewers = (rule.reviewers ?? []).map((reviewer) => ({ type: reviewer.type, id: reviewer.reviewer?.id }));
    }
  }
  return fields;
};

const needsBranchPolicy = (env: Environment) => {
  const policy = env.deployment_branch_policy;
  return !policy?.custom_branch_policies || Boolean(policy.protected_branches);
};

const environmentPath = (rt: Runtime, name: string) => `/repos/${rt.ctx.repo}/environments/${encodeURIComponent(name)}`;

const readBranchPolicies = (rt: Runtime, name: string) =>
  read(() =>
    rt.github!.request<{ branch_policies?: { name?: string; type?: string }[] }>(
      'GET',
      `${environmentPath(rt, name)}/deployment-branch-policies`,
    ),
  );

const environment: Resource = {
  id: 'gh.environment',
  severity: 'warn',
  scope: 'trust-chain',
  async evaluate(rt) {
    const env = rt.ctx.environment;
    if (!env) return { kind: 'skipped', message: 'environment disabled' };
    const createAll = (manual: boolean) => [
      change(this.id, 'create', `create environment ${env.name}`, manual),
      change(this.id, 'create', `allow only ${env.branch} to deploy to ${env.name}`, manual),
    ];
    if (!rt.github) return { kind: 'skipped', message: 'no GitHub credentials', changes: createAll(true) };

    const github = rt.github;
    const manual = rt.preflight.githubAdmin === false;
    const current = await read(() => github.request<Environment>('GET', environmentPath(rt, env.name)));
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift(createAll(manual), manual ? ADMIN_FIX : undefined);

    const changes: Change[] = [];
    if (needsBranchPolicy(current.value)) {
      changes.push(change(this.id, 'update', `limit ${env.name} to selected branches`, manual));
    }
    const branches = await readBranchPolicies(rt, env.name);
    if (branches.kind === 'skipped') return { kind: 'skipped', message: branches.reason };
    const names = branches.kind === 'found' ? (branches.value.branch_policies ?? []).map((p) => p.name) : [];
    if (!names.includes(env.branch))
      changes.push(change(this.id, 'create', `allow ${env.branch} to deploy to ${env.name}`, manual));
    if (!changes.length) return { kind: 'ok', message: `${env.name} only deploys from ${env.branch}` };
    return drift(changes, manual ? ADMIN_FIX : undefined);
  },
  async apply(rt) {
    const env = rt.ctx.environment;
    const github = rt.github;
    if (!env || !github) return;
    const path = environmentPath(rt, env.name);
    const current = await read(() => github.request<Environment>('GET', path));
    if (current.kind === 'skipped') return;
    if (current.kind === 'missing' || needsBranchPolicy(current.value)) {
      await github.request('PUT', path, {
        ...(current.kind === 'found' ? currentProtection(current.value) : {}),
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      });
    }
    const branches = await readBranchPolicies(rt, env.name);
    if (branches.kind === 'skipped') return;
    const names = branches.kind === 'found' ? (branches.value.branch_policies ?? []).map((p) => p.name) : [];
    if (!names.includes(env.branch)) {
      await github.request('POST', `${path}/deployment-branch-policies`, { name: env.branch, type: 'branch' });
    }
  },
};

/** In the order `setup` applies them. */
export const RESOURCES: readonly Resource[] = [
  apis,
  pool,
  provider,
  providerCondition,
  serviceAccount,
  projectRoles,
  workloadIdentityUser,
  runtimeServiceAccountUser,
  variables,
  environment,
];
