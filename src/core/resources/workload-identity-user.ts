import { IAM, repoPrincipal } from '../io/endpoints.js';
import { readServiceAccount, readServiceAccountPolicy } from '../io/google-reads.js';
import { updatePolicy } from '../io/writes.js';
import { hasMember } from '../policy.js';
import { change, drift, grant, type Resource } from './resource.js';

const WORKLOAD_IDENTITY_USER = 'roles/iam.workloadIdentityUser';

export const workloadIdentityUser: Resource = {
  id: 'gcp.wi-user',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const { serviceAccount: email, repo } = rt.ctx;
    const principal = repoPrincipal(rt.ctx);
    const bind = [
      change(
        this.id,
        'bind',
        `let ${repo} act as ${email} (${WORKLOAD_IDENTITY_USER})`,
        `let ${repo} deploy with the deploy account`,
      ),
    ];

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
