import { describe, expect, it } from 'vitest';
import { RESOURCES, resourceById } from '../../../src/core/resources/registry.js';
import { runtimeFor } from '../../helpers.js';

describe('RESOURCES', () => {
  it('lists resources in apply order', () => {
    expect(RESOURCES.map((r) => r.id)).toEqual([
      'gcp.apis',
      'gcp.pool',
      'gcp.provider',
      'gcp.provider-condition',
      'gcp.service-account',
      'gcp.project-roles',
      'gcp.wi-user',
      'gcp.runtime-sa-user',
      'gh.variables',
      'gh.environment',
    ]);
    expect(RESOURCES.filter((r) => r.severity === 'warn').map((r) => r.id)).toEqual(['gh.environment']);
  });

  it('passes for a fully set up project', async () => {
    const rt = await runtimeFor();
    for (const r of RESOURCES) {
      const outcome = await r.evaluate(rt);
      expect(outcome.kind, r.id).toBe(r.id === 'gcp.runtime-sa-user' ? 'skipped' : 'ok');
    }
  });
});

describe('resourceById', () => {
  it('finds each resource by its ID', () => {
    for (const r of RESOURCES) expect(resourceById(r.id)).toBe(r);
  });
});
