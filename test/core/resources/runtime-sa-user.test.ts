import { describe, expect, it } from 'vitest';
import { runtimeServiceAccountUser } from '../../../src/core/resources/runtime-sa-user.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.runtime-sa-user', () => {
  it('skips without the functions preset', async () => {
    expect(await runtimeServiceAccountUser.evaluate(await runtimeFor())).toEqual({
      kind: 'skipped',
      message: 'no functions preset',
    });
  });

  it('binds each runtime service account', async () => {
    const fakes = createConfiguredFakes({ presets: ['functions'] });
    const runtime = '123456789012-compute@developer.gserviceaccount.com';
    const rt = await runtimeFor(fakes);
    fakes.google.state.serviceAccounts[runtime]!.iamPolicy = {};
    expect(actions(await runtimeServiceAccountUser.evaluate(rt))).toEqual([
      `bind: let ${fakes.names.serviceAccount} act as runtime ${runtime} (roles/iam.serviceAccountUser)`,
    ]);
  });
});
