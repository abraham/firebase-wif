import { describe, expect, it } from 'vitest';
import { parseCli } from '../../src/cli/args.js';
import { buildOptions } from '../../src/cli/options.js';
import { createFakeGoogle } from '../../src/testing/index.js';

const argsFor = (argv: string[]) => {
  const result = parseCli(argv);
  if (result.kind !== 'run') throw new Error(result.kind);
  return result.args;
};

const build = (argv: string[], home?: { provider: string; serviceAccount: string }) =>
  buildOptions({
    args: argsFor(argv),
    resolved: { projectId: 'demo-project', repo: 'octo-org/site', local: {} },
    google: createFakeGoogle(),
    github: false,
    home,
  });

describe('buildOptions', () => {
  it('uses auto presets and the default environment', () => {
    expect(build([])).toMatchObject({
      projectId: 'demo-project',
      repo: 'octo-org/site',
      presets: 'auto',
      variables: { provider: 'FIREBASE_WIF_PROVIDER', serviceAccount: 'FIREBASE_WIF_SERVICE_ACCOUNT' },
      environment: { name: 'production', branch: undefined },
    });
  });

  it('maps names, presets, prefix, and environment flags', () => {
    expect(
      build([
        '--preset',
        'storage',
        '--pool',
        'pool-1',
        '--provider',
        'prov-1',
        '--service-account',
        'sa-1',
        '--variable-prefix',
        'WIF_',
        '--environment',
        'test',
        '--any-branch',
      ]),
    ).toMatchObject({
      presets: ['storage'],
      names: { pool: 'pool-1', provider: 'prov-1', serviceAccount: 'sa-1' },
      variables: { provider: 'WIF_PROVIDER', serviceAccount: 'WIF_SERVICE_ACCOUNT' },
      environment: { name: 'test', branch: false },
    });
    expect(build(['--no-environment']).environment).toBe(false);
    expect(build([]).previewEnvironment).toBeUndefined();
    expect(build(['--preview-environment', 'pr']).previewEnvironment).toEqual({ name: 'pr' });
    expect(build(['--no-preview-environment']).previewEnvironment).toBe(false);
  });

  it('passes the home trust chain only when there is one', () => {
    const home = { provider: 'projects/1/locations/global/workloadIdentityPools/p/providers/q', serviceAccount: 's' };
    expect(build([], home).home).toEqual(home);
    expect('home' in build([])).toBe(false);
  });
});
