import { describe, expect, it } from 'vitest';
import { status } from '../../src/core/engine/engine.js';
import type { PresetName } from '../../src/core/types.js';
import { createConfiguredFakes } from '../../src/testing/scenario.js';

describe('createConfiguredFakes', () => {
  it('uses the default names', () => {
    const fakes = createConfiguredFakes();
    expect(fakes.options).toEqual({ projectId: 'demo-project', repo: 'octo-org/site', presets: ['hosting'] });
    expect(fakes.names).toEqual({
      pool: 'projects/123456789012/locations/global/workloadIdentityPools/github',
      provider: 'projects/123456789012/locations/global/workloadIdentityPools/github/providers/github-987654321',
      serviceAccount: 'github-987654321@demo-project.iam.gserviceaccount.com',
      principal:
        'principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/github/attribute.repository_id/987654321',
    });
    expect(fakes.github.state.repos['octo-org/site']!.variables).toEqual({
      FIREBASE_WIF_PROVIDER: fakes.names.provider,
      FIREBASE_WIF_SERVICE_ACCOUNT: fakes.names.serviceAccount,
    });
  });

  it('accepts custom identifiers', () => {
    const fakes = createConfiguredFakes({
      projectId: 'other-project',
      projectNumber: '1',
      repo: 'a/b',
      repoId: 5,
      ownerId: 6,
      defaultBranch: 'trunk',
    });
    expect(fakes.names.serviceAccount).toBe('github-5@other-project.iam.gserviceaccount.com');
    expect(fakes.github.state.repos['a/b']).toMatchObject({
      id: 5,
      owner: { id: 6, login: 'a' },
      default_branch: 'trunk',
    });
    expect(fakes.github.state.repos['a/b']!.environments!.production!.branchPolicies).toEqual(['trunk']);
  });

  it('derives presets from firebase.json and adds the runtime account for functions', () => {
    const fakes = createConfiguredFakes({ firebaseJson: { hosting: {}, functions: {} } });
    expect(fakes.options.presets).toEqual(['hosting', 'functions']);
    expect(Object.keys(fakes.google.state.serviceAccounts)).toContain(
      '123456789012-compute@developer.gserviceaccount.com',
    );
  });

  it.each<PresetName[]>([
    ['hosting'],
    ['firestore'],
    ['storage'],
    ['functions'],
    ['hosting', 'firestore', 'storage', 'functions'],
  ])('passes status for %j', async (...presets) => {
    const fakes = createConfiguredFakes({ presets });
    const report = await status({ ...fakes.options, google: fakes.google, github: fakes.github });
    expect(report.ok).toBe(true);
    expect(report.changes).toEqual([]);
  });
});
