import { describe, expect, it } from 'vitest';
import { GITHUB_ADVISORIES } from '../../../src/core/checks/github.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { runtimeFor } from '../../helpers.js';

const { repo, legacySecrets, oidcSub, workflows } = GITHUB_ADVISORIES;

describe('GitHub checks', () => {
  it('gh.repo', async () => {
    const rt = await runtimeFor();
    expect((await repo.run(rt)).status).toBe('pass');
    expect((await repo.run({ ...rt, repo: { ...rt.repo, permissions: { admin: false } } })).status).toBe('warn');
    expect(await repo.run({ ...rt, github: undefined })).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('skipped'),
    });
  });

  it('gh.legacy-secrets', async () => {
    const fakes = createConfiguredFakes();
    fakes.github.state.repos['octo-org/site']!.secrets = [
      'FIREBASE_TOKEN',
      'GCP_SA_KEY',
      'GCP_SA_KEY_BACKUP',
      'NPM_TOKEN',
    ];
    const rt = await runtimeFor(fakes);
    expect(await legacySecrets.run(rt)).toMatchObject({
      status: 'warn',
      message: 'FIREBASE_TOKEN, GCP_SA_KEY still set',
    });
    expect((await legacySecrets.run({ ...rt, github: undefined })).status).toBe('skipped');
  });

  it('gh.oidc-sub', async () => {
    const fakes = createConfiguredFakes();
    const state = fakes.github.state.repos['octo-org/site']!;
    expect(await oidcSub.run(await runtimeFor(fakes))).toMatchObject({
      status: 'pass',
      message: expect.stringContaining('default sub template'),
    });

    state.oidcSub = {
      use_default: false,
      include_claim_keys: ['repo', 'context', 'job_workflow_ref', 'actor', 'workflow'],
    };
    expect(await oidcSub.run(await runtimeFor(fakes))).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('customized sub (repo, context, job_workflow_ref, actor, workflow)'),
    });

    const rt = await runtimeFor(fakes);
    expect((await oidcSub.run({ ...rt, github: undefined })).status).toBe('skipped');
  });

  it('gh.workflows', async () => {
    const rt = await runtimeFor();
    const deploy =
      'on: push\npermissions:\n  id-token: write\njobs:\n  d:\n    environment: production\n    steps:\n      - uses: abraham/firebase-wif@v0\n      - run: firebase deploy\n';
    expect(await workflows.run(rt)).toEqual({ status: 'skipped', message: 'no local files provided' });
    expect(await workflows.run({ ...rt, local: { workflows: { 'd.yml': deploy } } })).toEqual({
      status: 'pass',
      message: '1 deploy job look right',
    });
    const preview = deploy.replace('firebase deploy', 'firebase hosting:channel:deploy pr-1');
    expect(await workflows.run({ ...rt, local: { workflows: { 'd.yml': preview } } })).toMatchObject({
      status: 'warn',
      message: 'd.yml d: deploys to a preview channel in `production`, which only main can deploy to',
    });
    const previewRt = { ...rt, ctx: { ...rt.ctx, previewEnvironment: { name: 'preview' } } };
    expect(await workflows.run({ ...previewRt, local: { workflows: { 'd.yml': preview } } })).toMatchObject({
      message:
        'd.yml d: deploys to a preview channel in `production`, which only main can deploy to; use `environment: preview`',
    });
    const anyBranch = { ...rt, ctx: { ...rt.ctx, environment: { name: 'production', branch: false as const } } };
    expect(await workflows.run({ ...anyBranch, local: { workflows: { 'd.yml': preview } } })).toMatchObject({
      status: 'pass',
    });
    expect(await workflows.run({ ...rt, local: { workflows: { 'd.yml': 'jobs: [' } } })).toMatchObject({
      status: 'warn',
      message: "couldn't parse d.yml",
    });
    expect(await workflows.run({ ...rt, local: { workflows: {} } })).toMatchObject({ status: 'skipped' });
  });
});
