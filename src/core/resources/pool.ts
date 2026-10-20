import { IAM, poolId } from '../io/endpoints.js';
import { readPool } from '../io/google-reads.js';
import { waitForOperation, type Operation } from '../io/writes.js';
import { change, drift, type Resource } from './resource.js';

export const pool: Resource = {
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
