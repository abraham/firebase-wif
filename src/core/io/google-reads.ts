import type { Policy } from '../policy.js';
import { CRM, IAM, SERVICE_USAGE } from './endpoints.js';
import {
  read,
  type PoolResource,
  type ProviderResource,
  type Read,
  type Runtime,
  type ServiceAccountResource,
} from './reads.js';

interface ServiceState {
  name?: string;
  state?: 'STATE_UNSPECIFIED' | 'ENABLED' | 'DISABLED';
}

export const readServices = (rt: Runtime): Promise<Read<Map<string, boolean>>> =>
  rt.memo('services', () =>
    read(async () => {
      const { projectNumber, apis } = rt.ctx;
      const query = apis
        .map((api) => `names=${encodeURIComponent(`projects/${projectNumber}/services/${api}`)}`)
        .join('&');
      const { services = [] } = await rt.google.request<{ services?: ServiceState[] }>(
        'GET',
        `${SERVICE_USAGE}/projects/${projectNumber}/services:batchGet?${query}`,
      );
      const enabled = new Map(apis.map((api) => [api, false]));
      for (const service of services) {
        const api = service.name?.split('/').pop();
        if (api) enabled.set(api, service.state === 'ENABLED');
      }
      return enabled;
    }),
  );

/** IAM reads fail with 403 while the IAM API is off, so report them as blocked instead. */
const iamBlocked = async (rt: Runtime): Promise<string | undefined> => {
  const services = await readServices(rt);
  if (services.kind === 'found' && services.value.get('iam.googleapis.com') === false) {
    return 'blocked by gcp.apis (iam.googleapis.com is disabled)';
  }
  return undefined;
};

const iamRead = async <T>(rt: Runtime, key: string, load: () => Promise<T>): Promise<Read<T>> =>
  rt.memo(key, async () => {
    const blocked = await iamBlocked(rt);
    return blocked ? ({ kind: 'skipped', reason: blocked } as const) : read(load);
  });

export const readPool = (rt: Runtime) =>
  iamRead(rt, 'pool', () => rt.google.request<PoolResource>('GET', `${IAM}/${rt.ctx.pool}`));

export const readProvider = (rt: Runtime) =>
  iamRead(rt, 'provider', () => rt.google.request<ProviderResource>('GET', `${IAM}/${rt.ctx.provider}`));

export const readServiceAccount = (rt: Runtime) =>
  iamRead(rt, 'serviceAccount', () =>
    rt.google.request<ServiceAccountResource>('GET', `${IAM}/projects/-/serviceAccounts/${rt.ctx.serviceAccount}`),
  );

export const readServiceAccountKeys = (rt: Runtime) =>
  iamRead(rt, 'serviceAccountKeys', async () => {
    const { keys = [] } = await rt.google.request<{ keys?: { name?: string }[] }>(
      'GET',
      `${IAM}/projects/-/serviceAccounts/${rt.ctx.serviceAccount}/keys?keyTypes=USER_MANAGED`,
    );
    return keys;
  });

export const readServiceAccountPolicy = (rt: Runtime, email: string) =>
  iamRead(rt, `serviceAccountPolicy:${email}`, () =>
    rt.google.request<Policy>('POST', `${IAM}/projects/-/serviceAccounts/${email}:getIamPolicy`),
  );

export const readProjectPolicy = (rt: Runtime) =>
  rt.memo('projectPolicy', () =>
    read(() =>
      rt.google.request<Policy>('POST', `${CRM}/projects/${rt.ctx.projectId}:getIamPolicy`, {
        options: { requestedPolicyVersion: 3 },
      }),
    ),
  );
