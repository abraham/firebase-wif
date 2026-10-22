import { describe, expect, it } from 'vitest';
import {
  assertCanApply,
  CROSS_PROJECT_PERMISSIONS,
  runPreflight,
  SETUP_PERMISSIONS,
} from '../../../src/core/engine/permissions.js';
import type { Change } from '../../../src/core/types.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { runtimeFor } from '../../helpers.js';

const create: Change = { resource: 'gcp.pool', action: 'create', description: 'create pool', summary: 'create' };
const variable: Change = { resource: 'gh.variables', action: 'set', description: 'set it', summary: 'set' };

describe('runPreflight', () => {
  it('lists the setup permissions the operator lacks', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.grantedPermissions = ['serviceusage.services.enable'];
    const preflight = await runPreflight(fakes.google, rt.ctx, rt.repo, true);
    expect(preflight).toEqual({
      missingPermissions: SETUP_PERMISSIONS.filter((p) => p !== 'serviceusage.services.enable'),
      githubAdmin: true,
    });
  });

  it('checks fewer permissions in a project that reuses another chain, and skips GitHub when asked', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.grantedPermissions = [];
    const preflight = await runPreflight(fakes.google, { ...rt.ctx, homeProjectId: 'other' }, rt.repo, false);
    expect(preflight).toEqual({ missingPermissions: [...CROSS_PROJECT_PERMISSIONS], githubAdmin: undefined });
  });
});

describe('assertCanApply', () => {
  it('throws only when Google Cloud changes need missing permissions', () => {
    const missing = { missingPermissions: ['iam.serviceAccounts.create'], githubAdmin: true };
    expect(() => assertCanApply([create], missing)).toThrow(expect.objectContaining({ code: 'MISSING_PERMISSIONS' }));
    expect(() => assertCanApply([variable], missing)).not.toThrow();
    expect(() => assertCanApply([{ ...create, manual: true }], missing)).not.toThrow();
    expect(() => assertCanApply([create], { missingPermissions: [], githubAdmin: true })).not.toThrow();
  });
});
