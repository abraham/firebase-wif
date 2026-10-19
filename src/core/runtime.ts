import { statusOf } from './errors.js';
import type { Policy } from './policy.js';
import type { Context, GitHubClient, GoogleClient, LocalFiles, Preflight } from './types.js';

export const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
export const IAM = 'https://iam.googleapis.com/v1';
export const SERVICE_USAGE = 'https://serviceusage.googleapis.com/v1';

export type Read<T> = { kind: 'found'; value: T } | { kind: 'missing' } | { kind: 'skipped'; reason: string };

export interface PoolResource {
  name?: string;
  state?: 'STATE_UNSPECIFIED' | 'ACTIVE' | 'DELETED';
  disabled?: boolean;
}

export interface ProviderResource extends PoolResource {
  attributeMapping?: Record<string, string>;
  attributeCondition?: string;
  oidc?: { issuerUri?: string; allowedAudiences?: string[] };
}

export interface ServiceAccountResource {
  email?: string;
  disabled?: boolean;
  description?: string;
}

export interface RepoResource {
  id: number;
  owner: { id: number; login: string };
  default_branch: string;
  permissions?: { admin?: boolean };
}

export interface Runtime {
  ctx: Context;
  google: GoogleClient;
  /** `undefined` when GitHub is skipped. */
  github?: GitHubClient;
  local?: LocalFiles;
  repo: RepoResource;
  preflight: Preflight;
  variableValues: Map<string, Read<string>>;
  /** Remove unrequested project roles from a firebase-wif-managed service account. */
  prune?: boolean;
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

const describe = (error: unknown): string => {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
  return status === 403
    ? `insufficient permission (${message})`
    : `request failed${status ? ` (${status})` : ''}: ${message}`;
};

/** Turns a request into found/missing/skipped, so one unreadable resource never aborts a status run. */
export const read = async <T>(load: () => Promise<T>): Promise<Read<T>> => {
  try {
    return { kind: 'found', value: await load() };
  } catch (error) {
    if ((error as Error | undefined)?.name === 'AbortError') throw error;
    if (statusOf(error) === 404) return { kind: 'missing' };
    return { kind: 'skipped', reason: describe(error) };
  }
};

export const createMemo = () => {
  const cache = new Map<string, Promise<unknown>>();
  return <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key) as Promise<T>;
  };
};

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

export const poolId = (ctx: Context): string => ctx.pool.split('/').pop()!;
export const providerId = (ctx: Context): string => ctx.provider.split('/').pop()!;

/** The principal set for this repository in the pool, which may live in the home project. */
export const repoPrincipal = (ctx: Context): string =>
  `principalSet://iam.googleapis.com/${ctx.pool}/attribute.repository_id/${ctx.repoId}`;

/** Deploy roles for another project, using the trust chain set up in the home project (5.8). */
export const isCrossProject = (ctx: Context): boolean => ctx.homeProjectId !== ctx.projectId;
