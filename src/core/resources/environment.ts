import { read, type Runtime } from '../io/reads.js';
import type { Change } from '../types.js';
import { ADMIN_FIX, change, drift, type Resource } from './resource.js';

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

export const environment: Resource = {
  id: 'gh.environment',
  severity: 'warn',
  scope: 'trust-chain',
  async evaluate(rt) {
    const env = rt.ctx.environment;
    if (!env) return { kind: 'skipped', message: 'environment disabled' };
    const anyBranch = (manual: boolean) =>
      change(
        this.id,
        'set',
        `allow any branch to deploy to ${env.name}`,
        `let any branch deploy to ${env.name}`,
        manual,
      );
    const createAll = (manual: boolean) => [
      change(this.id, 'create', `create environment ${env.name}`, `create the ${env.name} environment`, manual),
      env.branch === false
        ? anyBranch(manual)
        : change(
            this.id,
            'create',
            `allow only ${env.branch} to deploy to ${env.name}`,
            `only let ${env.branch} deploy to ${env.name}`,
            manual,
          ),
    ];
    if (!rt.github) return { kind: 'skipped', message: 'no GitHub credentials', changes: createAll(true) };

    const github = rt.github;
    const manual = rt.preflight.githubAdmin === false;
    const current = await read(() => github.request<Environment>('GET', environmentPath(rt, env.name)));
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift(createAll(manual), manual ? ADMIN_FIX : undefined);

    if (env.branch === false) {
      if (!current.value.deployment_branch_policy) return { kind: 'ok', message: `${env.name} allows any branch` };
      return drift([anyBranch(manual)], manual ? ADMIN_FIX : undefined);
    }

    const changes: Change[] = [];
    if (needsBranchPolicy(current.value)) {
      changes.push(
        change(
          this.id,
          'update',
          `limit ${env.name} to selected branches`,
          `limit which branches deploy to ${env.name}`,
          manual,
        ),
      );
    }
    const branches = await readBranchPolicies(rt, env.name);
    if (branches.kind === 'skipped') return { kind: 'skipped', message: branches.reason };
    const names = branches.kind === 'found' ? (branches.value.branch_policies ?? []).map((p) => p.name) : [];
    if (!names.includes(env.branch))
      changes.push(
        change(
          this.id,
          'create',
          `allow ${env.branch} to deploy to ${env.name}`,
          `let ${env.branch} deploy to ${env.name}`,
          manual,
        ),
      );
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
    const protection = current.kind === 'found' ? currentProtection(current.value) : {};

    if (env.branch === false) {
      if (current.kind === 'missing' || current.value.deployment_branch_policy) {
        await github.request('PUT', path, { ...protection, deployment_branch_policy: null });
      }
      return;
    }

    if (current.kind === 'missing' || needsBranchPolicy(current.value)) {
      await github.request('PUT', path, {
        ...protection,
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
