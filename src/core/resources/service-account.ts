import { IAM } from '../io/endpoints.js';
import { readServiceAccount } from '../io/google-reads.js';
import { managedDescription, serviceAccountProject } from '../naming.js';
import { change, drift, type Resource } from './resource.js';

export const serviceAccount: Resource = {
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
