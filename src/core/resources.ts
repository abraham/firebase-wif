import { FirebaseWifError } from './errors.js';
import {
  desiredAttributeMapping,
  ISSUER,
  REQUIRED_MAPPING_KEYS,
  repoPrincipalSet,
} from './naming.js';
import { analyzeCondition, hasMember } from './policy.js';
import {
  poolId,
  providerId,
  read,
  readPool,
  readProjectPolicy,
  readProvider,
  readServiceAccount,
  readServiceAccountPolicy,
  readServices,
  type Runtime,
} from './runtime.js';
import { SERVICE_ACCOUNT_USER_ROLE } from '../presets.js';
import type { Change, ChangeAction } from './types.js';

export type Outcome =
  | { kind: 'ok'; message: string }
  | { kind: 'drift'; message: string; changes: Change[]; fix?: string }
  | { kind: 'skipped'; message: string; changes?: Change[] }
  | { kind: 'blocked'; message: string; fix: string; error: FirebaseWifError };

/** A resource `setup` reconciles; its check fails exactly when its plan has changes. */
export interface Resource {
  id: string;
  severity: 'fail' | 'warn';
  evaluate(rt: Runtime): Promise<Outcome>;
}

const change = (resource: string, action: ChangeAction, description: string, manual = false): Change =>
  manual ? { resource, action, description, manual } : { resource, action, description };

const drift = (changes: Change[]): Outcome => ({
  kind: 'drift',
  message: changes.map((c) => c.description).join('; '),
  changes,
});

const apis: Resource = {
  id: 'gcp.apis',
  severity: 'fail',
  async evaluate(rt) {
    const services = await readServices(rt);
    if (services.kind !== 'found') return { kind: 'skipped', message: services.kind === 'skipped' ? services.reason : 'unknown' };
    const disabled = [...services.value].filter(([, on]) => !on).map(([api]) => api);
    if (!disabled.length) return { kind: 'ok', message: `${services.value.size}/${services.value.size} enabled` };
    return drift([change(this.id, 'enable', `enable ${disabled.join(', ')}`)]);
  },
};

const pool: Resource = {
  id: 'gcp.pool',
  severity: 'fail',
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
};

const provider: Resource = {
  id: 'gcp.provider',
  severity: 'fail',
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
      return { kind: 'blocked', message, fix, error: new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', message, { fix }) };
    }
    const changes: Change[] = [];
    if (value.disabled) changes.push(change(this.id, 'update', `re-enable provider ${id}`));
    const desired = desiredAttributeMapping();
    const missing = REQUIRED_MAPPING_KEYS.filter((key) => value.attributeMapping?.[key] !== desired[key]);
    if (missing.length) changes.push(change(this.id, 'update', `map ${missing.join(', ')} on provider ${id}`));
    return changes.length ? drift(changes) : { kind: 'ok', message: `${id} trusts ${ISSUER}` };
  },
};

const providerCondition: Resource = {
  id: 'gcp.provider-condition',
  severity: 'fail',
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
        const fix = 'Pass --provider with a different provider ID; never re-point another repo\'s provider.';
        return { kind: 'blocked', message, fix, error: new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', message, { fix }) };
      }
      case 'missing':
        return drift([change(this.id, 'update', `limit provider ${id} to ${repo} (no attribute condition)`)]);
      case 'name-only':
        return drift([change(this.id, 'update', `pin provider ${id} to repository ID ${repoId} instead of the name ${repo}`)]);
      case 'loose':
        return drift([change(this.id, 'update', `limit provider ${id} to ${repo} (condition doesn't pin a repository ID)`)]);
    }
  },
};

const serviceAccount: Resource = {
  id: 'gcp.service-account',
  severity: 'fail',
  async evaluate(rt) {
    const email = rt.ctx.serviceAccount;
    const current = await readServiceAccount(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift([change(this.id, 'create', `create service account ${email}`)]);
    if (current.value.disabled) return drift([change(this.id, 'enable', `enable service account ${email}`)]);
    return { kind: 'ok', message: `${email} exists` };
  },
};

const projectRoles: Resource = {
  id: 'gcp.project-roles',
  severity: 'fail',
  async evaluate(rt) {
    const { serviceAccount: email, roles, projectId } = rt.ctx;
    const policy = await readProjectPolicy(rt);
    if (policy.kind === 'skipped') return { kind: 'skipped', message: policy.reason };
    const member = `serviceAccount:${email}`;
    const missing = policy.kind === 'found' ? roles.filter((role) => !hasMember(policy.value, role, member)) : roles;
    if (!missing.length) return { kind: 'ok', message: `${roles.length} role${roles.length === 1 ? '' : 's'} on ${projectId}` };
    return drift(missing.map((role) => change(this.id, 'bind', `grant ${role} on ${projectId} to ${email}`)));
  },
};

const workloadIdentityUser: Resource = {
  id: 'gcp.wi-user',
  severity: 'fail',
  async evaluate(rt) {
    const { serviceAccount: email, projectNumber, repo, repoId } = rt.ctx;
    const principal = repoPrincipalSet(projectNumber, poolId(rt.ctx), repoId);
    const bind = [change(this.id, 'bind', `let ${repo} act as ${email} (roles/iam.workloadIdentityUser)`)];

    const account = await readServiceAccount(rt);
    if (account.kind === 'skipped') return { kind: 'skipped', message: account.reason };
    if (account.kind === 'missing') return drift(bind);

    const policy = await readServiceAccountPolicy(rt, email);
    if (policy.kind === 'skipped') return { kind: 'skipped', message: policy.reason };
    if (policy.kind === 'found' && hasMember(policy.value, 'roles/iam.workloadIdentityUser', principal)) {
      return { kind: 'ok', message: `${repo} can act as ${email}` };
    }
    return drift(bind);
  },
};

const runtimeServiceAccountUser: Resource = {
  id: 'gcp.runtime-sa-user',
  severity: 'fail',
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
};

const variables: Resource = {
  id: 'gh.variables',
  severity: 'fail',
  async evaluate(rt) {
    const names = rt.ctx.variables;
    if (!names) return { kind: 'skipped', message: 'repo variables disabled' };
    const expected: [string, string][] = [
      [names.provider, rt.ctx.provider],
      [names.serviceAccount, rt.ctx.serviceAccount],
    ];
    if (!rt.github) {
      return {
        kind: 'skipped',
        message: 'no GitHub credentials',
        changes: expected.map(([name, value]) => change(this.id, 'set', `set repo variable ${name} to ${value}`, true)),
      };
    }
    const changes: Change[] = [];
    for (const [name, value] of expected) {
      const current = rt.variableValues.get(name) ?? { kind: 'skipped', reason: 'not read' };
      if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
      if (current.kind === 'missing' || current.value !== value) {
        changes.push(change(this.id, 'set', `set repo variable ${name} to ${value}`));
      }
    }
    return changes.length ? drift(changes) : { kind: 'ok', message: `${names.provider} and ${names.serviceAccount} match` };
  },
};

interface Environment {
  deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null;
}

const environment: Resource = {
  id: 'gh.environment',
  severity: 'warn',
  async evaluate(rt) {
    const env = rt.ctx.environment;
    if (!env) return { kind: 'skipped', message: 'environment disabled' };
    const base = `/repos/${rt.ctx.repo}/environments/${encodeURIComponent(env.name)}`;
    const createAll = (manual: boolean) => [
      change(this.id, 'create', `create environment ${env.name}`, manual),
      change(this.id, 'create', `allow only ${env.branch} to deploy to ${env.name}`, manual),
    ];
    if (!rt.github) return { kind: 'skipped', message: 'no GitHub credentials', changes: createAll(true) };

    const github = rt.github;
    const current = await read(() => github.request<Environment>('GET', base));
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift(createAll(false));

    const changes: Change[] = [];
    const policy = current.value.deployment_branch_policy;
    if (!policy?.custom_branch_policies || policy.protected_branches) {
      changes.push(change(this.id, 'update', `limit ${env.name} to selected branches`));
    }
    const branches = await read(() =>
      github.request<{ branch_policies?: { name?: string; type?: string }[] }>('GET', `${base}/deployment-branch-policies`),
    );
    if (branches.kind === 'skipped') return { kind: 'skipped', message: branches.reason };
    const names = branches.kind === 'found' ? (branches.value.branch_policies ?? []).map((p) => p.name) : [];
    if (!names.includes(env.branch)) changes.push(change(this.id, 'create', `allow ${env.branch} to deploy to ${env.name}`));
    return changes.length ? drift(changes) : { kind: 'ok', message: `${env.name} only deploys from ${env.branch}` };
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
