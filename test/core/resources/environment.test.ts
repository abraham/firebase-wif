import { describe, expect, it } from 'vitest';
import { environment } from '../../../src/core/resources/environment.js';
import { createConfiguredFakes, type ConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

const env = (fakes: ConfiguredFakes) => fakes.github.state.repos['octo-org/site']!.environments!;

describe('gh.environment', () => {
  it('creates a missing environment and branch policy', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    delete env(fakes).production;
    expect(actions(await environment.evaluate(rt))).toEqual([
      'create: create environment production',
      'create: allow only main to deploy to production',
    ]);
  });

  it('limits the environment to the deploy branch', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    env(fakes).production = { deployment_branch_policy: null, branchPolicies: [] };
    expect(actions(await environment.evaluate(rt))).toEqual([
      'update: limit production to selected branches',
      'create: allow main to deploy to production',
    ]);

    env(fakes).production = {
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      branchPolicies: ['main'],
    };
    expect(actions(await environment.evaluate(rt))).toEqual(['update: limit production to selected branches']);
  });

  it('skips when disabled, unreadable, or without GitHub', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    expect(await environment.evaluate({ ...rt, ctx: { ...rt.ctx, environment: false } })).toEqual({
      kind: 'skipped',
      message: 'environment disabled',
    });
    expect((await environment.evaluate({ ...rt, github: undefined })).kind).toBe('skipped');
    fakes.github.state.forbidden = ['deployment-branch-policies'];
    expect(await environment.evaluate(rt)).toMatchObject({
      kind: 'skipped',
      message: expect.stringContaining('insufficient permission'),
    });
  });
});
