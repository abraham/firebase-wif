import { describe, expect, it } from 'vitest';
import { buildContext, isCrossProject } from '../../../src/core/engine/chain.js';
import type { Read, RepoResource } from '../../../src/core/io/reads.js';
import type { Options } from '../../../src/core/types.js';

const REPO: RepoResource = { id: 42, owner: { id: 7, login: 'octo-org' }, default_branch: 'main' };
const VARIABLES = { provider: 'FIREBASE_WIF_PROVIDER', serviceAccount: 'FIREBASE_WIF_SERVICE_ACCOUNT' };
const OPTIONS: Options = { projectId: 'demo-project', repo: 'octo-org/site' };

const build = (options: Partial<Options> = {}, values: [string, string][] = []) =>
  buildContext(
    { ...OPTIONS, ...options },
    REPO,
    '123',
    VARIABLES,
    new Map<string, Read<string>>(values.map(([name, value]) => [name, { kind: 'found', value }])),
    undefined,
  );

describe('buildContext', () => {
  it('uses the default names', () => {
    expect(build()).toMatchObject({
      pool: 'projects/123/locations/global/workloadIdentityPools/github',
      provider: 'projects/123/locations/global/workloadIdentityPools/github/providers/github-42',
      serviceAccount: 'github-42@demo-project.iam.gserviceaccount.com',
      homeProjectId: 'demo-project',
      environment: { name: 'production', branch: 'main' },
      presets: ['hosting'],
    });
  });

  it('follows repo variables in the same project', () => {
    const ctx = build({}, [
      ['FIREBASE_WIF_PROVIDER', 'projects/123/locations/global/workloadIdentityPools/pool-1/providers/prov-1'],
      ['FIREBASE_WIF_SERVICE_ACCOUNT', 'deployer@demo-project.iam.gserviceaccount.com'],
    ]);
    expect(ctx).toMatchObject({
      provider: 'projects/123/locations/global/workloadIdentityPools/pool-1/providers/prov-1',
      serviceAccount: 'deployer@demo-project.iam.gserviceaccount.com',
    });
  });

  it('reuses a chain in another project and drops the token exchange APIs', () => {
    const ctx = build({
      home: {
        provider: 'projects/999/locations/global/workloadIdentityPools/github/providers/github-42',
        serviceAccount: 'github-42@home-project.iam.gserviceaccount.com',
      },
    });
    expect(ctx.homeProjectId).toBe('home-project');
    expect(isCrossProject(ctx)).toBe(true);
    expect(ctx.apis).not.toContain('sts.googleapis.com');
  });

  it('rejects an invalid home provider', () => {
    expect(() => build({ home: { provider: 'nope', serviceAccount: 'a@b.iam.gserviceaccount.com' } })).toThrow(
      expect.objectContaining({ code: 'INVALID_NAME' }),
    );
  });
});
