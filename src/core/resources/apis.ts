import { SERVICE_USAGE } from '../io/endpoints.js';
import { readServices } from '../io/google-reads.js';
import { waitForOperation, type Operation } from '../io/writes.js';
import { change, drift, type Resource } from './resource.js';

export const apis: Resource = {
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
