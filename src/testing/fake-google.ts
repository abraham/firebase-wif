import { HttpError } from '../core/errors.js';
import type { Policy } from '../core/policy.js';
import type { GoogleClient } from '../core/types.js';

export type { Binding, Policy } from '../core/policy.js';

export interface FakeProject {
  projectId: string;
  projectNumber: string;
  enabledServices: string[];
  iamPolicy: Policy;
  /** What `testIamPermissions` grants the caller; every requested permission when omitted. */
  grantedPermissions?: string[];
}

export interface FakePool {
  state?: 'ACTIVE' | 'DELETED';
  disabled?: boolean;
}

export interface FakeProvider extends FakePool {
  attributeMapping?: Record<string, string>;
  attributeCondition?: string;
  oidc?: { issuerUri?: string; allowedAudiences?: string[] };
}

export interface FakeServiceAccount {
  projectId: string;
  disabled?: boolean;
  description?: string;
  keys?: string[];
  iamPolicy?: Policy;
}

export interface FakeGoogleState {
  projects: FakeProject[];
  /** Keyed by full resource name with the project number, like `projects/123/locations/global/workloadIdentityPools/github`. */
  pools: Record<string, FakePool>;
  /** Keyed by full provider resource name. */
  providers: Record<string, FakeProvider>;
  /** Keyed by email. */
  serviceAccounts: Record<string, FakeServiceAccount>;
  /** Requests whose URL contains any of these answer 403. */
  forbidden: string[];
}

export interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

export interface FakeGoogle extends GoogleClient {
  state: FakeGoogleState;
  calls: RecordedCall[];
}

const notFound = (what: string) => new HttpError(404, `${what} not found`);
const clone = <T>(value: T): T => structuredClone(value);

/** An in-memory Google Cloud backend for the IAM, Resource Manager, and Service Usage endpoints firebase-wif uses. */
export const createFakeGoogle = (seed: Partial<FakeGoogleState> = {}): FakeGoogle => {
  const state: FakeGoogleState = {
    projects: [],
    pools: {},
    providers: {},
    serviceAccounts: {},
    forbidden: [],
    ...clone(seed),
  };
  const calls: RecordedCall[] = [];

  const project = (idOrNumber: string) => {
    const found = state.projects.find((p) => p.projectId === idOrNumber || p.projectNumber === idOrNumber);
    if (!found) throw notFound(`project ${idOrNumber}`);
    return found;
  };

  const requireService = (projectIdOrNumber: string, service: string) => {
    if (!project(projectIdOrNumber).enabledServices.includes(service)) {
      throw new HttpError(403, `${service} has not been used in project ${projectIdOrNumber} before or it is disabled.`);
    }
  };

  const getPolicy = (policy: Policy): Policy => ({ version: 1, etag: 'BwX0', bindings: [], ...clone(policy) });

  const setPolicy = (current: Policy, next: Policy): Policy => {
    if (next.etag && current.etag && next.etag !== current.etag) throw new HttpError(409, 'etag mismatch');
    const etag = `BwX${Number.parseInt((current.etag ?? 'BwX0').slice(3), 10) + 1}`;
    return { ...clone(next), etag };
  };

  const resourceName = (path: string, kind: 'pool' | 'provider') => {
    const match =
      /^projects\/([^/]+)\/locations\/global\/workloadIdentityPools\/([^/:]+)(?:\/providers\/([^/:]+))?$/.exec(path);
    if (!match || (kind === 'provider') !== Boolean(match[3])) return undefined;
    const { projectNumber } = project(match[1]!);
    requireService(projectNumber, 'iam.googleapis.com');
    const pool = `projects/${projectNumber}/locations/global/workloadIdentityPools/${match[2]}`;
    return kind === 'pool' ? pool : `${pool}/providers/${match[3]}`;
  };

  const serviceAccount = (email: string) => {
    const account = state.serviceAccounts[email];
    if (!account) throw notFound(`service account ${email}`);
    requireService(account.projectId, 'iam.googleapis.com');
    return account;
  };

  const route = (method: string, url: URL, body: unknown): unknown => {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\//, ''));

    if (url.hostname === 'cloudresourcemanager.googleapis.com') {
      const match = /^projects\/([^/:]+)(?::(getIamPolicy|setIamPolicy|testIamPermissions))?$/.exec(path);
      if (!match) throw notFound(path);
      const target = project(match[1]!);
      switch (`${method} ${match[2] ?? ''}`) {
        case 'GET ':
          return { projectId: target.projectId, projectNumber: target.projectNumber, lifecycleState: 'ACTIVE' };
        case 'POST getIamPolicy':
          return getPolicy(target.iamPolicy);
        case 'POST setIamPolicy':
          target.iamPolicy = setPolicy(getPolicy(target.iamPolicy), (body as { policy: Policy }).policy);
          return getPolicy(target.iamPolicy);
        case 'POST testIamPermissions': {
          const requested = (body as { permissions?: string[] }).permissions ?? [];
          const granted = target.grantedPermissions;
          return { permissions: granted ? requested.filter((p) => granted.includes(p)) : requested };
        }
      }
      throw notFound(path);
    }

    if (url.hostname === 'serviceusage.googleapis.com') {
      const batch = /^projects\/([^/]+)\/services:batchGet$/.exec(path);
      if (batch && method === 'GET') {
        const target = project(batch[1]!);
        return {
          services: url.searchParams.getAll('names').map((name) => ({
            name: name.replace(/^projects\/[^/]+/, `projects/${target.projectNumber}`),
            state: target.enabledServices.includes(name.split('/').pop()!) ? 'ENABLED' : 'DISABLED',
          })),
        };
      }
      const single = /^projects\/([^/]+)\/services\/([^/:]+)$/.exec(path);
      if (single && method === 'GET') {
        const target = project(single[1]!);
        return {
          name: `projects/${target.projectNumber}/services/${single[2]}`,
          state: target.enabledServices.includes(single[2]!) ? 'ENABLED' : 'DISABLED',
        };
      }
      throw notFound(path);
    }

    if (url.hostname === 'iam.googleapis.com') {
      const account = /^projects\/[^/]+\/serviceAccounts\/([^/:]+)(\/keys|:getIamPolicy|:setIamPolicy)?$/.exec(path);
      if (account) {
        const email = account[1]!;
        const target = serviceAccount(email);
        switch (`${method} ${account[2] ?? ''}`) {
          case 'GET ':
            return { email, disabled: target.disabled ?? false, description: target.description };
          case 'GET /keys':
            // The fake only stores user-managed keys, which is all firebase-wif asks for.
            return { keys: (target.keys ?? []).map((id) => ({ name: `projects/-/serviceAccounts/${email}/keys/${id}` })) };
          case 'POST :getIamPolicy':
            return getPolicy(target.iamPolicy ?? {});
          case 'POST :setIamPolicy':
            target.iamPolicy = setPolicy(getPolicy(target.iamPolicy ?? {}), (body as { policy: Policy }).policy);
            return getPolicy(target.iamPolicy);
        }
        throw notFound(path);
      }

      const pool = resourceName(path, 'pool');
      if (pool && method === 'GET') {
        const value = state.pools[pool];
        if (!value) throw notFound(pool);
        return { name: pool, state: 'ACTIVE', disabled: false, ...clone(value) };
      }
      const provider = resourceName(path, 'provider');
      if (provider && method === 'GET') {
        const value = state.providers[provider];
        if (!value) throw notFound(provider);
        return { name: provider, state: 'ACTIVE', disabled: false, ...clone(value) };
      }
    }

    throw notFound(url.toString());
  };

  return {
    state,
    calls,
    async request<T>(method: string, url: string, body?: unknown): Promise<T> {
      calls.push(body === undefined ? { method, url } : { method, url, body: clone(body) });
      if (state.forbidden.some((fragment) => url.includes(fragment))) throw new HttpError(403, 'The caller does not have permission');
      return clone(route(method, new URL(url), body)) as T;
    },
  };
};
