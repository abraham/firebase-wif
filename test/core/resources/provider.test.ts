import { describe, expect, it } from 'vitest';
import { provider } from '../../../src/core/resources/provider.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.provider', () => {
  it('creates the provider without reading it when the pool is missing', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    delete fakes.google.state.pools[fakes.names.pool];
    expect(actions(await provider.evaluate(rt))).toEqual(['create: create provider github-987654321']);
    expect(fakes.google.calls.some((c) => c.url.includes('/providers/'))).toBe(false);
  });

  it('creates, restores, and re-enables the provider', async () => {
    const fakes = createConfiguredFakes();
    const current = fakes.google.state.providers[fakes.names.provider]!;

    delete fakes.google.state.providers[fakes.names.provider];
    expect(actions(await provider.evaluate(await runtimeFor(fakes)))).toEqual([
      'create: create provider github-987654321',
    ]);

    fakes.google.state.providers[fakes.names.provider] = { ...current, state: 'DELETED' };
    expect(actions(await provider.evaluate(await runtimeFor(fakes)))).toEqual([
      'undelete: restore deleted provider github-987654321',
    ]);

    fakes.google.state.providers[fakes.names.provider] = { ...current, disabled: true, attributeMapping: {} };
    expect(actions(await provider.evaluate(await runtimeFor(fakes)))).toEqual([
      'update: re-enable provider github-987654321',
      'update: map google.subject, attribute.repository_id on provider github-987654321',
    ]);
  });

  it('blocks providers for other issuers', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.oidc = {};
    expect(await provider.evaluate(rt)).toMatchObject({
      kind: 'blocked',
      message: 'Provider github-987654321 uses issuer (none), not GitHub Actions.',
      error: { code: 'PROVIDER_OWNED_BY_OTHER_REPO' },
    });
  });
});
