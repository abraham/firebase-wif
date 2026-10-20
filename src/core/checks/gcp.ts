import { repoPrincipal } from '../io/endpoints.js';
import {
  readProjectPolicy,
  readServiceAccount,
  readServiceAccountKeys,
  readServiceAccountPolicy,
} from '../io/google-reads.js';
import { MANAGED_MARKER } from '../naming.js';
import { rolesOf } from '../policy.js';
import { pass, skipped, warn, type Advisory } from './advisory.js';

const IMPERSONATION_ROLES = ['roles/iam.workloadIdentityUser', 'roles/iam.serviceAccountTokenCreator'];

const project: Advisory = {
  id: 'gcp.project',
  async run(rt) {
    return pass(`${rt.ctx.projectId} accessible (#${rt.ctx.projectNumber})`);
  },
};

const operator: Advisory = {
  id: 'gcp.operator',
  async run(rt) {
    const missing = rt.preflight.missingPermissions;
    return missing.length
      ? warn(
          `you're missing ${missing.join(', ')}, so setup can't run`,
          'Ask a project owner to run firebase-wif setup.',
        )
      : pass('you can run setup');
  },
};

const serviceAccountKeys: Advisory = {
  id: 'gcp.sa-keys',
  async run(rt) {
    const account = await readServiceAccount(rt);
    if (account.kind !== 'found')
      return skipped(account.kind === 'missing' ? "service account doesn't exist yet" : account.reason);
    const keys = await readServiceAccountKeys(rt);
    if (keys.kind !== 'found') return skipped(keys.kind === 'missing' ? 'service account not found' : keys.reason);
    return keys.value.length
      ? warn(
          `${keys.value.length} user-managed key${keys.value.length === 1 ? '' : 's'} on ${rt.ctx.serviceAccount}`,
          'Delete the keys once deploys use WIF.',
        )
      : pass('no user-managed keys');
  },
};

const extraRoles: Advisory = {
  id: 'gcp.extra-roles',
  async run(rt) {
    const policy = await readProjectPolicy(rt);
    if (policy.kind !== 'found') return skipped(policy.kind === 'missing' ? 'project policy not found' : policy.reason);
    const extra = rolesOf(policy.value, `serviceAccount:${rt.ctx.serviceAccount}`).filter(
      (role) => !rt.ctx.roles.includes(role),
    );
    if (!extra.length) return pass('no roles beyond the requested ones');
    const account = await readServiceAccount(rt);
    const managed = account.kind === 'found' && account.value.description?.includes(MANAGED_MARKER);
    const note = rt.prune && !managed ? " (not pruned: firebase-wif doesn't manage this service account)" : '';
    return warn(
      `${rt.ctx.serviceAccount} also has ${extra.join(', ')}${note}`,
      managed ? 'firebase-wif setup --prune' : 'Remove the extra roles if deploys no longer need them.',
    );
  },
};

const broadImpersonation: Advisory = {
  id: 'gcp.wi-user-broad',
  async run(rt) {
    const account = await readServiceAccount(rt);
    if (account.kind !== 'found')
      return skipped(account.kind === 'missing' ? "service account doesn't exist yet" : account.reason);
    const policy = await readServiceAccountPolicy(rt, rt.ctx.serviceAccount);
    if (policy.kind !== 'found')
      return skipped(policy.kind === 'missing' ? 'service account not found' : policy.reason);
    const ours = repoPrincipal(rt.ctx);
    const broad = (policy.value.bindings ?? [])
      .filter((binding) => IMPERSONATION_ROLES.includes(binding.role))
      .flatMap((binding) => binding.members ?? [])
      .filter((member) => /^principal(Set)?:\/\//.test(member) && member !== ours);
    return broad.length
      ? warn(
          `other identities can act as ${rt.ctx.serviceAccount}: ${[...new Set(broad)].join(', ')}`,
          'Remove the grants unless they are intended.',
        )
      : pass('only this repository can act as the service account');
  },
};

export const GCP_ADVISORIES = {
  project,
  operator,
  serviceAccountKeys,
  extraRoles,
  broadImpersonation,
} as const satisfies Record<string, Advisory>;
