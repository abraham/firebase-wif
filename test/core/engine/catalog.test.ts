import { describe, expect, it } from 'vitest';
import { entries } from '../../../src/core/engine/catalog.js';
import { runtimeFor } from '../../helpers.js';

const ids = (list: ReturnType<typeof entries>) =>
  list.map((entry) => ('advisory' in entry ? entry.advisory.id : entry.resource.id));

describe('entries', () => {
  it('lists every check in report order', async () => {
    const { ctx } = await runtimeFor();
    expect(ids(entries(ctx))).toEqual([
      'local.firebase-json',
      'local.project-match',
      'local.creds-ignored',
      'gcp.project',
      'gcp.operator',
      'gcp.apis',
      'gcp.pool',
      'gcp.provider',
      'gcp.provider-condition',
      'gcp.service-account',
      'gcp.sa-keys',
      'gcp.project-roles',
      'gcp.extra-roles',
      'gcp.wi-user',
      'gcp.wi-user-broad',
      'gh.repo',
      'gh.variables',
      'gh.environment',
      'gh.legacy-secrets',
      'gh.oidc-sub',
      'gh.workflows',
    ]);
  });

  it('includes the runtime service account check only with functions', async () => {
    const { ctx } = await runtimeFor();
    const withFunctions = ids(entries({ ...ctx, runtimeServiceAccounts: ['r@p.iam.gserviceaccount.com'] }));
    expect(withFunctions.indexOf('gcp.runtime-sa-user')).toBe(withFunctions.indexOf('gcp.wi-user-broad') + 1);
  });
});
