import { SERVICE_ACCOUNT_USER_ROLE } from '../../presets.js';
import { IAM } from '../io/endpoints.js';
import { readServiceAccountPolicy } from '../io/google-reads.js';
import { updatePolicy } from '../io/writes.js';
import { runtimeLabel } from '../naming.js';
import { hasMember } from '../policy.js';
import type { Change } from '../types.js';
import { change, drift, grant, type Resource } from './resource.js';

export const runtimeServiceAccountUser: Resource = {
  id: 'gcp.runtime-sa-user',
  severity: 'fail',
  scope: 'project',
  async evaluate(rt) {
    const { serviceAccount: email, runtimeServiceAccounts } = rt.ctx;
    if (!runtimeServiceAccounts.length) return { kind: 'skipped', message: 'no functions preset' };
    const member = `serviceAccount:${email}`;
    const changes: Change[] = [];
    const notes: string[] = [];
    const existing: string[] = [];
    for (const runtime of runtimeServiceAccounts) {
      const policy = await readServiceAccountPolicy(rt, runtime);
      if (policy.kind === 'skipped') return { kind: 'skipped', message: policy.reason };
      if (policy.kind === 'missing') {
        notes.push(`${runtime} doesn't exist yet`);
        continue;
      }
      existing.push(runtime);
      if (!hasMember(policy.value, SERVICE_ACCOUNT_USER_ROLE, member)) {
        changes.push(
          change(
            this.id,
            'bind',
            `let ${email} act as runtime ${runtime} (${SERVICE_ACCOUNT_USER_ROLE})`,
            `let the deploy account run functions as ${runtimeLabel(runtime, rt.ctx)}`,
          ),
        );
      }
    }
    if (changes.length) return drift(changes);
    if (!existing.length) return { kind: 'skipped', message: notes.join('; ') };
    return { kind: 'ok', message: `${email} can act as ${existing.join(', ')}` };
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
