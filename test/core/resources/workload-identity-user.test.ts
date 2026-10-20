import { describe, expect, it } from 'vitest';
import { workloadIdentityUser } from '../../../src/core/resources/workload-identity-user.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.wi-user', () => {
  it("binds without reading the policy of a service account that doesn't exist", async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    expect(actions(await workloadIdentityUser.evaluate(rt))).toEqual([
      `bind: let octo-org/site act as ${fakes.names.serviceAccount} (roles/iam.workloadIdentityUser)`,
    ]);
    expect(fakes.google.calls.some((c) => c.url.endsWith(':getIamPolicy'))).toBe(false);
  });

  it('only accepts the repository principal set', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy = {
      bindings: [
        { role: 'roles/iam.workloadIdentityUser', members: [fakes.names.principal.replace('987654321', '1')] },
      ],
    };
    expect((await workloadIdentityUser.evaluate(rt)).kind).toBe('drift');
  });
});
