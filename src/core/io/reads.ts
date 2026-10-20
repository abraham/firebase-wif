import { isAbortError, statusOf } from '../errors.js';
import type { Context, GitHubClient, GoogleClient, LocalFiles, Preflight } from '../types.js';

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
  github?: GitHubClient | undefined;
  local?: LocalFiles | undefined;
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
    if (isAbortError(error)) throw error;
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
