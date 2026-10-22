import { describe, expect, it } from 'vitest';
import { evaluate, inspect, readVariables, toCheck, withSignal } from '../../../src/core/engine/inspect.js';
import { pool } from '../../../src/core/resources/pool.js';
import { variables } from '../../../src/core/resources/variables.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { runtimeFor } from '../../helpers.js';

describe('inspect', () => {
  it('reports a fully set up project with its runtime and nothing blocked', async () => {
    const fakes = createConfiguredFakes();
    const inspection = await inspect({ ...fakes.options, google: fakes.google, github: fakes.github });
    expect(inspection.report.ok).toBe(true);
    expect(inspection.blocked).toEqual([]);
    expect(inspection.runtime.ctx).toBe(inspection.report.context);
  });
});

describe('evaluate', () => {
  it('skips trust-chain resources in a project that reuses another chain', async () => {
    const rt = await runtimeFor();
    const cross = { ...rt, ctx: { ...rt.ctx, homeProjectId: 'home-project' } };
    expect(await evaluate(pool, cross)).toEqual({
      kind: 'skipped',
      message: 'shared from home-project; check it with --project home-project',
    });
    expect((await evaluate(pool, rt)).kind).toBe('ok');
  });
});

describe('toCheck', () => {
  it('maps outcomes to check statuses and fixes', () => {
    expect(toCheck(pool, { kind: 'ok', message: 'fine' })).toEqual({ id: 'gcp.pool', status: 'pass', message: 'fine' });
    expect(toCheck(pool, { kind: 'drift', message: 'x', changes: [] })).toMatchObject({
      status: 'fail',
      fix: 'firebase-wif setup',
    });
    const manual = {
      resource: 'gh.variables' as const,
      action: 'set' as const,
      description: 'set it',
      summary: 'set',
      manual: true,
    };
    expect(toCheck(variables, { kind: 'skipped', message: 'no GitHub', changes: [manual] })).toMatchObject({
      status: 'skipped',
      fix: 'set it',
    });
  });
});

describe('readVariables', () => {
  it('reads both variables, or nothing without GitHub or variables', async () => {
    const fakes = createConfiguredFakes();
    const values = await readVariables(fakes.github, 'octo-org/site', {
      provider: 'FIREBASE_WIF_PROVIDER',
      serviceAccount: 'MISSING',
    });
    expect(values.get('FIREBASE_WIF_PROVIDER')).toEqual({ kind: 'found', value: fakes.names.provider });
    expect(values.get('MISSING')).toEqual({ kind: 'missing' });
    expect((await readVariables(undefined, 'octo-org/site', false)).size).toBe(0);
  });
});

describe('withSignal', () => {
  it('stops requests once the signal fires', async () => {
    const fakes = createConfiguredFakes();
    const controller = new AbortController();
    const client = withSignal(fakes.github, controller.signal);
    await client.request('GET', '/repos/octo-org/site');
    controller.abort();
    await expect(async () => client.request('GET', '/repos/octo-org/site')).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(withSignal(fakes.github, undefined)).toBe(fakes.github);
  });
});
