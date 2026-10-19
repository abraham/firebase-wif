import { describe, expect, it } from 'vitest';
import { GCP_ADVISORIES, GITHUB_ADVISORIES, LOCAL_CHECKS, type Advisory } from '../../src/core/checks.js';
import type { Runtime } from '../../src/core/runtime.js';
import { createConfiguredFakes } from '../../src/testing/index.js';
import { runtimeFor } from '../helpers.js';

const all: Advisory[] = [...LOCAL_CHECKS, ...Object.values(GCP_ADVISORIES), ...GITHUB_ADVISORIES];
const advisory = (id: string) => all.find((a) => a.id === id)!;
const run = (id: string, rt: Runtime) => advisory(id).run(rt);

describe('advisories', () => {
  it('have unique IDs', () => {
    const ids = all.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'local.firebase-json',
      'local.project-match',
      'local.creds-ignored',
      'gcp.project',
      'gcp.operator',
      'gcp.sa-keys',
      'gcp.extra-roles',
      'gcp.wi-user-broad',
      'gh.repo',
      'gh.legacy-secrets',
      'gh.oidc-sub',
      'gh.workflows',
    ]);
  });

  it('skip local checks without local files', async () => {
    const rt = await runtimeFor();
    for (const id of ['local.firebase-json', 'local.project-match', 'local.creds-ignored', 'gh.workflows']) {
      expect(await run(id, rt), id).toEqual({ status: 'skipped', message: 'no local files provided' });
    }
  });
});

describe('local checks', () => {
  it('local.firebase-json', async () => {
    const rt = await runtimeFor();
    expect((await run('local.firebase-json', { ...rt, local: {} })).status).toBe('warn');
    expect((await run('local.firebase-json', { ...rt, local: { firebaseJson: {} } })).status).toBe('pass');
  });

  it('local.project-match', async () => {
    const rt = await runtimeFor();
    expect(await run('local.project-match', { ...rt, local: {} })).toMatchObject({ status: 'warn', fix: 'firebase use --add demo-project' });
    expect((await run('local.project-match', { ...rt, local: { firebaserc: { projects: { default: 'demo-project' } } } })).status).toBe('pass');
    expect((await run('local.project-match', { ...rt, local: { firebaserc: { projects: { default: 'other-project' } } } })).status).toBe('warn');
    expect(
      await run('local.project-match', { ...rt, local: { firebaserc: { projects: { default: 'other-project', staging: 'demo-project' } } } }),
    ).toEqual({ status: 'pass', message: 'alias staging is demo-project' });
  });

  it('local.creds-ignored', async () => {
    const rt = await runtimeFor();
    const workflows = { 'a.yml': 'jobs:\n  x:\n    steps:\n      - uses: google-github-actions/auth@v3\n' };

    expect((await run('local.creds-ignored', { ...rt, local: { workflows: {} } })).status).toBe('pass');
    expect(await run('local.creds-ignored', { ...rt, local: { workflows, firebaseJson: { hosting: [{ public: '.' }] } } })).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('.gitignore or the Hosting ignore list'),
    });
    expect(
      (
        await run('local.creds-ignored', {
          ...rt,
          local: { workflows, gitignore: 'gha-creds-*.json\n', firebaseJson: { hosting: { public: '.', ignore: ['**/gha-creds-*.json'] } } },
        })
      ).status,
    ).toBe('pass');
    expect((await run('local.creds-ignored', { ...rt, local: { workflows, gitignore: 'gha-creds-*.json', firebaseJson: { hosting: { public: 'dist' } } } })).status).toBe('pass');
  });
});

describe('Google Cloud checks', () => {
  it('gcp.project and gcp.operator', async () => {
    const rt = await runtimeFor();
    expect(await run('gcp.project', rt)).toEqual({ status: 'pass', message: 'demo-project accessible (#123456789012)' });
    expect((await run('gcp.operator', rt)).status).toBe('pass');
    expect(
      await run('gcp.operator', { ...rt, preflight: { missingPermissions: ['iam.serviceAccounts.create'], githubAdmin: true } }),
    ).toMatchObject({ status: 'warn', message: expect.stringContaining('iam.serviceAccounts.create') });
  });

  it('gcp.sa-keys', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    expect((await run('gcp.sa-keys', rt)).status).toBe('pass');

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.keys = ['a', 'b'];
    expect(await run('gcp.sa-keys', await runtimeFor(fakes))).toMatchObject({ status: 'warn', message: expect.stringContaining('2 user-managed keys') });

    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    expect(await run('gcp.sa-keys', await runtimeFor(fakes))).toEqual({ status: 'skipped', message: "service account doesn't exist yet" });
  });

  it('gcp.extra-roles suggests --prune only for managed accounts', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.projects[0]!.iamPolicy.bindings!.push({ role: 'roles/editor', members: [`serviceAccount:${fakes.names.serviceAccount}`] });
    expect(await run('gcp.extra-roles', await runtimeFor(fakes))).toMatchObject({ status: 'warn', fix: 'firebase-wif setup --prune' });

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.description = 'made by hand';
    expect(await run('gcp.extra-roles', await runtimeFor(fakes))).toMatchObject({ fix: 'Remove the extra roles if deploys no longer need them.' });
  });

  it('gcp.wi-user-broad', async () => {
    const fakes = createConfiguredFakes();
    expect((await run('gcp.wi-user-broad', await runtimeFor(fakes))).status).toBe('pass');

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy!.bindings!.push(
      { role: 'roles/iam.serviceAccountTokenCreator', members: ['principal://iam.googleapis.com/x/subject/y'] },
      { role: 'roles/viewer', members: ['principalSet://iam.googleapis.com/ignored'] },
    );
    expect(await run('gcp.wi-user-broad', await runtimeFor(fakes))).toMatchObject({
      status: 'warn',
      message: expect.not.stringContaining('ignored'),
    });
  });
});

describe('GitHub checks', () => {
  it('gh.repo', async () => {
    const rt = await runtimeFor();
    expect((await run('gh.repo', rt)).status).toBe('pass');
    expect((await run('gh.repo', { ...rt, repo: { ...rt.repo, permissions: { admin: false } } })).status).toBe('warn');
    expect(await run('gh.repo', { ...rt, github: undefined })).toMatchObject({ status: 'pass', message: expect.stringContaining('skipped') });
  });

  it('gh.legacy-secrets', async () => {
    const fakes = createConfiguredFakes();
    fakes.github.state.repos['octo-org/site']!.secrets = ['FIREBASE_TOKEN', 'GCP_SA_KEY', 'GCP_SA_KEY_BACKUP', 'NPM_TOKEN'];
    const rt = await runtimeFor(fakes);
    expect(await run('gh.legacy-secrets', rt)).toMatchObject({ status: 'warn', message: 'FIREBASE_TOKEN, GCP_SA_KEY still set' });
    expect((await run('gh.legacy-secrets', { ...rt, github: undefined })).status).toBe('skipped');
  });

  it('gh.oidc-sub', async () => {
    const fakes = createConfiguredFakes();
    const repo = fakes.github.state.repos['octo-org/site']!;
    expect(await run('gh.oidc-sub', await runtimeFor(fakes))).toMatchObject({ status: 'pass', message: expect.stringContaining('default sub template') });

    repo.oidcSub = { use_default: false, include_claim_keys: ['repo', 'context', 'job_workflow_ref', 'actor', 'workflow'] };
    expect(await run('gh.oidc-sub', await runtimeFor(fakes))).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('customized sub (repo, context, job_workflow_ref, actor, workflow)'),
    });

    const rt = await runtimeFor(fakes);
    expect((await run('gh.oidc-sub', { ...rt, github: undefined })).status).toBe('skipped');
  });

  it('gh.workflows', async () => {
    const rt = await runtimeFor();
    const deploy = 'on: push\npermissions:\n  id-token: write\njobs:\n  d:\n    steps:\n      - uses: abraham/firebase-wif@v0\n      - run: firebase deploy\n';
    expect(await run('gh.workflows', { ...rt, local: { workflows: { 'd.yml': deploy } } })).toEqual({ status: 'pass', message: '1 deploy job look right' });
    expect(await run('gh.workflows', { ...rt, local: { workflows: { 'd.yml': 'jobs: [' } } })).toMatchObject({ status: 'warn', message: "couldn't parse d.yml" });
    expect(await run('gh.workflows', { ...rt, local: { workflows: {} } })).toMatchObject({ status: 'skipped' });
  });
});
