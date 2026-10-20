import { describe, expect, it } from 'vitest';
import { poolId, providerId, repoPrincipal } from '../../../src/core/io/endpoints.js';
import { runtimeFor } from '../../helpers.js';

describe('endpoints', () => {
  it('extracts IDs from full resource names', async () => {
    const rt = await runtimeFor();
    expect(poolId(rt.ctx)).toBe('github');
    expect(providerId(rt.ctx)).toBe('github-987654321');
  });

  it('builds the repository principal set in the pool', async () => {
    const rt = await runtimeFor();
    expect(repoPrincipal(rt.ctx)).toBe(
      `principalSet://iam.googleapis.com/${rt.ctx.pool}/attribute.repository_id/${rt.ctx.repoId}`,
    );
  });
});
