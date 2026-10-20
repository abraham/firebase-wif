import { describe, expect, it } from 'vitest';
import { providerCondition } from '../../../src/core/resources/provider-condition.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.provider-condition', () => {
  it.each([
    [undefined, ['update: limit provider github-987654321 to octo-org/site (no attribute condition)']],
    [
      "assertion.repository == 'octo-org/site'",
      ['update: pin provider github-987654321 to repository ID 987654321 instead of the name octo-org/site'],
    ],
    [
      "assertion.repository_owner_id == '1234567'",
      ["update: limit provider github-987654321 to octo-org/site (condition doesn't pin a repository ID)"],
    ],
    ["assertion.repository_id == '987654321'", 'ok'],
  ])('%s', async (condition, expected) => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = condition;
    expect(actions(await providerCondition.evaluate(rt))).toEqual(expected);
  });

  it('blocks providers that trust another repository', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = "assertion.repository == 'other/repo'";
    expect(await providerCondition.evaluate(rt)).toMatchObject({
      kind: 'blocked',
      error: { code: 'PROVIDER_OWNED_BY_OTHER_REPO' },
      fix: expect.stringContaining('--provider'),
    });
  });

  it("skips providers that don't exist yet", async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.state = 'DELETED';
    expect(await providerCondition.evaluate(rt)).toEqual({
      kind: 'skipped',
      message: "provider github-987654321 doesn't exist yet",
    });
  });
});
