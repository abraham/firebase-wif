import { describe, expect, it } from 'vitest';
import { pool } from '../../../src/core/resources/pool.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.pool', () => {
  it.each([
    [undefined, ['create: create workload identity pool github']],
    [{ state: 'DELETED' as const }, ['undelete: restore deleted workload identity pool github']],
    [{ state: 'ACTIVE' as const, disabled: true }, ['update: re-enable workload identity pool github']],
  ])('%j', async (state, expected) => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    if (state) fakes.google.state.pools[fakes.names.pool] = state;
    else delete fakes.google.state.pools[fakes.names.pool];
    expect(actions(await pool.evaluate(rt))).toEqual(expected);
  });
});
