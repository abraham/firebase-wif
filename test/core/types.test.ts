import { describe, expectTypeOf, it } from 'vitest';
import type {
  Change,
  Check,
  GitHubAuth,
  GitHubClient,
  GoogleAuth,
  GoogleClient,
  Options,
  ProgressEvent,
  StatusReport,
} from '../../src/core/types.js';

describe('types', () => {
  it('lets existing clients and tokens stand in for auth', () => {
    const client = { request: async <T>(_method: string, _url: string, _body?: unknown): Promise<T> => ({}) as T };
    expectTypeOf(client).toExtend<GoogleClient>();
    expectTypeOf(client).toExtend<GitHubClient>();
    expectTypeOf({ accessToken: 'x' }).toExtend<GoogleAuth>();
    expectTypeOf({ getAccessToken: async () => 'x' }).toExtend<GoogleAuth>();
    expectTypeOf({ token: 'x' }).toExtend<GitHubAuth>();
  });

  it('only requires the project and repo', () => {
    expectTypeOf({ projectId: 'p', repo: 'o/r' }).toExtend<Options>();
    expectTypeOf({ projectId: 'p' }).not.toExtend<Options>();
    expectTypeOf({
      projectId: 'p',
      repo: 'o/r',
      github: false as const,
      environment: false as const,
      variables: false as const,
    }).toExtend<Options>();
  });

  it('discriminates progress events', () => {
    expectTypeOf<Extract<ProgressEvent, { type: 'check' }>>().toEqualTypeOf<{ type: 'check'; check: Check }>();
    expectTypeOf<Extract<ProgressEvent, { change: unknown }>>().toEqualTypeOf<{
      type: 'change:start' | 'change:done';
      change: Change;
    }>();
  });

  it('reports checks with a fixed set of statuses', () => {
    expectTypeOf<Check['status']>().toEqualTypeOf<'pass' | 'warn' | 'fail' | 'skipped'>();
    expectTypeOf<StatusReport['ok']>().toEqualTypeOf<boolean>();
  });
});
