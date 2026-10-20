import { describe, expect, it } from 'vitest';
import { variables } from '../../../src/core/resources/variables.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gh.variables', () => {
  it('sets missing and stale variables', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    rt.variableValues.set('FIREBASE_WIF_PROVIDER', { kind: 'missing' });
    rt.variableValues.set('FIREBASE_WIF_SERVICE_ACCOUNT', {
      kind: 'found',
      value: 'old@demo-project.iam.gserviceaccount.com',
    });
    expect(actions(await variables.evaluate(rt))).toEqual([
      `set: set repo variable FIREBASE_WIF_PROVIDER to ${fakes.names.provider}`,
      `set: set repo variable FIREBASE_WIF_SERVICE_ACCOUNT to ${fakes.names.serviceAccount}`,
    ]);
  });

  it('skips unreadable or disabled variables, and lists manual steps without GitHub', async () => {
    const rt = await runtimeFor();
    rt.variableValues.set('FIREBASE_WIF_PROVIDER', { kind: 'skipped', reason: 'insufficient permission (x)' });
    expect(await variables.evaluate(rt)).toEqual({
      kind: 'skipped',
      message: 'insufficient permission (x)',
    });

    expect(await variables.evaluate({ ...rt, ctx: { ...rt.ctx, variables: false } })).toEqual({
      kind: 'skipped',
      message: 'repo variables disabled',
    });

    const outcome = await variables.evaluate({ ...rt, github: undefined });
    expect(outcome).toMatchObject({ kind: 'skipped', message: 'no GitHub credentials' });
    expect(outcome.kind === 'skipped' && outcome.changes?.every((c) => c.manual)).toBe(true);
  });
});
