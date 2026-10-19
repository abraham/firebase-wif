import { HttpError } from '../core/errors.js';
import { poolName } from '../core/naming.js';
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
  displayName?: string;
  description?: string;
}

export interface FakeProvider extends FakePool {
  attributeMapping?: Record<string, string>;
  attributeCondition?: string;
  oidc?: { issuerUri?: string; allowedAudiences?: string[] };
}

export interface FakeServiceAccount {
  projectId: string;
  disabled?: boolean;
  displayName?: string;
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
  /** One-off errors, like IAM eventual consistency right after creating a service account. */
  failures: FakeFailure[];
  /** How many times a new long-running operation answers `done: false` before it's done. */
  pendingPolls: number;
  /** Simulates the `constraints/iam.workloadIdentityPoolProviders` org policy when set. */
  allowedIssuers?: string[];
}

export interface FakeFailure {
  /** Matches requests whose URL contains this. */
  url: string;
  method?: string;
  status: number;
  message?: string;
  /** Default 1. */
  times?: number;
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
    failures: [],
    pendingPolls: 0,
    ...clone(seed),
  };
  const calls: RecordedCall[] = [];
  const operations = new Map<string, number>();
  let operationCount = 0;

  const operation = (parent: string) => {
    const name = `${parent ? `${parent}/` : ''}operations/op-${++operationCount}`;
    if (state.pendingPolls > 0) operations.set(name, state.pendingPolls);
    return { name, done: state.pendingPolls <= 0 };
  };

  const pollOperation = (name: string) => {
    const left = operations.get(name);
    if (left === undefined) return { name, done: true };
    if (left <= 1) operations.delete(name);
    else operations.set(name, left - 1);
    return { name, done: left <= 1 };
  };

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

  /** GET, PATCH with an update mask, and `:undelete` for pools and providers. */
  const wiResource = (
    collection: Record<string, FakeProvider>,
    name: string,
    method: string,
    verb: string,
    url: URL,
    body: unknown,
  ): unknown => {
    const value = collection[name];
    if (!value) throw notFound(name);
    switch (`${method} ${verb}`) {
      case 'GET ':
        return { name, state: 'ACTIVE', disabled: false, ...clone(value) };
      case 'PATCH ':
        for (const field of (url.searchParams.get('updateMask') ?? '').split(',').filter(Boolean)) {
          (value as Record<string, unknown>)[field] = clone((body as Record<string, unknown>)[field]);
        }
        return operation(name);
      case 'POST undelete':
        if (value.state !== 'DELETED') throw new HttpError(400, `${name} is not deleted`);
        value.state = 'ACTIVE';
        return operation(name);
    }
    throw notFound(name);
  };

  const createIn = (collection: Record<string, FakeProvider>, name: string, value: FakeProvider) => {
    // Soft-deleted resources keep their ID reserved.
    if (collection[name]) throw new HttpError(409, `${name} already exists`);
    collection[name] = { state: 'ACTIVE', disabled: false, ...clone(value) };
    return operation(name);
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
      if (/^operations\/[^/]+$/.test(path) && method === 'GET') return pollOperation(path);
      const enable = /^projects\/([^/]+)\/services:batchEnable$/.exec(path);
      if (enable && method === 'POST') {
        const target = project(enable[1]!);
        const ids = (body as { serviceIds?: string[] }).serviceIds ?? [];
        target.enabledServices = [...new Set([...target.enabledServices, ...ids])];
        return operation('');
      }
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
      if (/\/operations\/[^/]+$/.test(path) && method === 'GET') return pollOperation(path);

      const accounts = /^projects\/([^/]+)\/serviceAccounts$/.exec(path);
      if (accounts && method === 'POST') {
        const target = project(accounts[1]!);
        requireService(target.projectId, 'iam.googleapis.com');
        const { accountId, serviceAccount: fields = {} } = body as {
          accountId: string;
          serviceAccount?: { displayName?: string; description?: string };
        };
        const email = `${accountId}@${target.projectId}.iam.gserviceaccount.com`;
        if (state.serviceAccounts[email]) throw new HttpError(409, `${email} already exists`);
        state.serviceAccounts[email] = { projectId: target.projectId, ...clone(fields) };
        return { email, ...fields };
      }

      const account = /^projects\/[^/]+\/serviceAccounts\/([^/:]+)(\/keys|:getIamPolicy|:setIamPolicy|:enable)?$/.exec(path);
      if (account) {
        const email = account[1]!;
        const target = serviceAccount(email);
        switch (`${method} ${account[2] ?? ''}`) {
          case 'GET ':
            return { email, disabled: target.disabled ?? false, displayName: target.displayName, description: target.description };
          case 'POST :enable':
            target.disabled = false;
            return {};
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

      const [resource = '', verb = ''] = path.split(':');
      const pools = /^projects\/([^/]+)\/locations\/global\/workloadIdentityPools$/.exec(resource);
      if (pools && method === 'POST') {
        const { projectNumber } = project(pools[1]!);
        requireService(projectNumber, 'iam.googleapis.com');
        const id = url.searchParams.get('workloadIdentityPoolId') ?? '';
        return createIn(state.pools, poolName(projectNumber, id), body as FakePool);
      }
      const providers = /^(projects\/[^/]+\/locations\/global\/workloadIdentityPools\/[^/]+)\/providers$/.exec(resource);
      if (providers && method === 'POST') {
        const pool = resourceName(providers[1]!, 'pool')!;
        if (!state.pools[pool] || state.pools[pool].state === 'DELETED') throw notFound(pool);
        const value = body as FakeProvider;
        const issuer = value.oidc?.issuerUri ?? '';
        if (state.allowedIssuers && !state.allowedIssuers.includes(issuer)) {
          throw new HttpError(400, `Org Policy violated for value: '${issuer}'. Constraint: constraints/iam.workloadIdentityPoolProviders.`);
        }
        const id = url.searchParams.get('workloadIdentityPoolProviderId') ?? '';
        return createIn(state.providers, `${pool}/providers/${id}`, value);
      }
      const pool = resourceName(resource, 'pool');
      if (pool) return wiResource(state.pools, pool, method, verb, url, body);
      const provider = resourceName(resource, 'provider');
      if (provider) return wiResource(state.providers, provider, method, verb, url, body);
    }

    throw notFound(url.toString());
  };

  const injectedFailure = (method: string, url: string) => {
    const index = state.failures.findIndex((f) => url.includes(f.url) && (!f.method || f.method === method));
    if (index < 0) return undefined;
    const failure = state.failures[index]!;
    const times = (failure.times ?? 1) - 1;
    if (times > 0) failure.times = times;
    else state.failures.splice(index, 1);
    return new HttpError(failure.status, failure.message ?? `injected ${failure.status}`);
  };

  return {
    state,
    calls,
    async request<T>(method: string, url: string, body?: unknown): Promise<T> {
      calls.push(body === undefined ? { method, url } : { method, url, body: clone(body) });
      if (state.forbidden.some((fragment) => url.includes(fragment))) throw new HttpError(403, 'The caller does not have permission');
      const failure = injectedFailure(method, url);
      if (failure) throw failure;
      return clone(route(method, new URL(url), body)) as T;
    },
  };
};
