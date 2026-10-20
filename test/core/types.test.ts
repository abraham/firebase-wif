import { describe, expectTypeOf, it } from 'vitest';
import type { ResolvedContext } from '../../src/core/context.js';
import { isFirebaseWifError, type ApplyFailure } from '../../src/core/errors.js';
import type {
  Change,
  Check,
  CheckId,
  GitHubAuth,
  GitHubClient,
  GoogleAuth,
  GoogleClient,
  Options,
  ProgressEvent,
  ResourceId,
  SetupResult,
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

  it('types check and resource IDs', () => {
    expectTypeOf<Check['id']>().toEqualTypeOf<CheckId>();
    expectTypeOf<Change['resource']>().toEqualTypeOf<ResourceId>();
    expectTypeOf<ResourceId>().toExtend<CheckId>();
    expectTypeOf<'gh.workflows'>().toExtend<CheckId>();
    expectTypeOf<'gh.workflows'>().not.toExtend<ResourceId>();
  });

  it('spreads a resolved context into options', () => {
    expectTypeOf<ResolvedContext>().toExtend<Options>();
  });

  it('narrows setup results and errors', () => {
    const result = {} as SetupResult;
    if (result.cancelled) expectTypeOf(result.plan.changes).toEqualTypeOf<Change[]>();
    else expectTypeOf(result.applied).toEqualTypeOf<Change[]>();

    const error: unknown = undefined;
    if (isFirebaseWifError(error, 'MISSING_PERMISSIONS'))
      expectTypeOf(error.details).toEqualTypeOf<{ missingPermissions: string[] }>();
    if (isFirebaseWifError(error, 'APPLY_FAILED')) expectTypeOf(error.details).toEqualTypeOf<ApplyFailure>();
  });
});
