import { CRM } from '../io/endpoints.js';
import { readProjectPolicy, readServiceAccount } from '../io/google-reads.js';
import type { Read, Runtime } from '../io/reads.js';
import { updatePolicy } from '../io/writes.js';
import { MANAGED_MARKER, roleLabel } from '../naming.js';
import { addMember, hasMember, removeMember, rolesOf, type Policy } from '../policy.js';
import { change, drift, type Resource } from './resource.js';

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

export const projectRoles: Resource = {
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
      ...missing.map((role) =>
        change(this.id, 'bind', `grant ${role} on ${projectId} to ${email}`, `grant ${roleLabel(role)} access`),
      ),
      ...extra.map((role) =>
        change(this.id, 'unbind', `remove ${role} on ${projectId} from ${email}`, `remove ${roleLabel(role)} access`),
      ),
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
