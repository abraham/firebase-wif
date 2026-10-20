import { describe, expect, it } from 'vitest';
import { serviceAccount } from '../../../src/core/resources/service-account.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.service-account', () => {
  it('creates and enables the service account', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.disabled = true;
    expect(actions(await serviceAccount.evaluate(rt))).toEqual([
      `enable: enable service account ${fakes.names.serviceAccount}`,
    ]);

    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    expect(actions(await serviceAccount.evaluate(await runtimeFor(fakes)))).toEqual([
      `create: create service account ${fakes.names.serviceAccount}`,
    ]);
  });
});
