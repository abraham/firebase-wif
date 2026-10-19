import { HttpError } from '../core/errors.js';
import type { GitHubClient } from '../core/types.js';
import type { RecordedCall } from './fake-google.js';

export interface FakeEnvironment {
  deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null;
  branchPolicies: string[];
}

export interface FakeRepo {
  id: number;
  owner: { id: number; login: string };
  default_branch: string;
  permissions?: { admin?: boolean };
  variables?: Record<string, string>;
  secrets?: string[];
  environments?: Record<string, FakeEnvironment>;
  oidcSub?: { use_default: boolean; include_claim_keys?: string[] };
}

export interface FakeGitHubState {
  /** Keyed by `owner/name`. */
  repos: Record<string, FakeRepo>;
  /** Requests whose path contains any of these answer 403. */
  forbidden: string[];
}

export interface FakeGitHub extends GitHubClient {
  state: FakeGitHubState;
  calls: RecordedCall[];
}

const notFound = (what: string) => new HttpError(404, `${what} not found`);

/** An in-memory GitHub backend for the repository endpoints firebase-wif uses. */
export const createFakeGitHub = (seed: Partial<FakeGitHubState> = {}): FakeGitHub => {
  const state: FakeGitHubState = { repos: {}, forbidden: [], ...structuredClone(seed) };
  const calls: RecordedCall[] = [];

  const route = (method: string, path: string, body: unknown): unknown => {
    const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    const repo = match ? state.repos[match[1]!] : undefined;
    if (!match || !repo) throw notFound(path);
    const rest = match[2] ?? '';
    const { variables = {}, secrets = [], environments = {} } = repo;

    if (rest === '' && method === 'GET') {
      return { id: repo.id, owner: repo.owner, default_branch: repo.default_branch, permissions: repo.permissions ?? { admin: true } };
    }

    if (rest === '/actions/variables' && method === 'POST') {
      const { name, value } = body as { name: string; value: string };
      if (name in variables) throw new HttpError(409, 'already exists');
      repo.variables = { ...variables, [name]: value };
      return {};
    }
    const variable = /^\/actions\/variables\/([^/]+)$/.exec(rest);
    if (variable) {
      const name = variable[1]!;
      if (!(name in variables)) throw notFound(`variable ${name}`);
      if (method === 'GET') return { name, value: variables[name] };
      if (method === 'PATCH') {
        repo.variables = { ...variables, [name]: (body as { value: string }).value };
        return {};
      }
    }

    if (rest === '/actions/secrets' && method === 'GET') {
      return { total_count: secrets.length, secrets: secrets.map((name) => ({ name })) };
    }

    if (rest === '/actions/oidc/customization/sub' && method === 'GET') {
      return repo.oidcSub ?? { use_default: true };
    }

    const environment = /^\/environments\/([^/]+)(\/deployment-branch-policies)?$/.exec(rest);
    if (environment) {
      const name = decodeURIComponent(environment[1]!);
      const current = environments[name];
      if (environment[2]) {
        if (!current) throw notFound(`environment ${name}`);
        if (method === 'GET') {
          return {
            total_count: current.branchPolicies.length,
            branch_policies: current.branchPolicies.map((branch) => ({ name: branch, type: 'branch' })),
          };
        }
        if (method === 'POST') {
          current.branchPolicies.push((body as { name: string }).name);
          return {};
        }
      } else if (method === 'GET') {
        if (!current) throw notFound(`environment ${name}`);
        return { name, deployment_branch_policy: current.deployment_branch_policy };
      } else if (method === 'PUT') {
        const policy = (body as { deployment_branch_policy?: FakeEnvironment['deployment_branch_policy'] }).deployment_branch_policy ?? null;
        repo.environments = { ...environments, [name]: { deployment_branch_policy: policy, branchPolicies: current?.branchPolicies ?? [] } };
        return {};
      }
    }

    throw notFound(path);
  };

  return {
    state,
    calls,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push(body === undefined ? { method, url: path } : { method, url: path, body: structuredClone(body) });
      if (state.forbidden.some((fragment) => path.includes(fragment))) throw new HttpError(403, 'Resource not accessible by integration');
      return structuredClone(route(method, path.split('?')[0]!, body)) as T;
    },
  };
};
