import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../../src/cli/main.js';
import { FirebaseWifError } from '../../src/index.js';
import { createConfiguredFakes, type ConfiguredFakes } from '../../src/testing/index.js';

const repoDir = async () => {
  const root = await mkdtemp(join(tmpdir(), 'firebase-wif-cli-'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ hosting: { public: 'dist' } }));
  await writeFile(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
  return root;
};

const cli = async (argv: string[], fakes: ConfiguredFakes, deps: Partial<CliDeps> = {}) => {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd: await repoDir(),
    env: {},
    exec: async () => 'https://github.com/octo-org/site.git',
    googleClient: async () => fakes.google,
    githubClient: async () => fakes.github,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...deps,
  });
  return { code, stdout, stderr };
};

describe('firebase-wif status', () => {
  it('prints a passing report', async () => {
    const { code, stdout, stderr } = await cli([], createConfiguredFakes());
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toMatchInlineSnapshot(`
      "firebase-wif status
        project  demo-project (#123456789012, from .firebaserc default)
        repo     octo-org/site (id 987654321, from git remote origin)

        Local
          ✓ local.firebase-json     found
          ✓ local.project-match     default is demo-project
          ✓ local.creds-ignored     no workflow writes credential files into the workspace

        Google Cloud
          ✓ gcp.project             demo-project accessible (#123456789012)
          ✓ gcp.operator            you can run setup
          ✓ gcp.apis                5/5 enabled
          ✓ gcp.pool                github is active
          ✓ gcp.provider            github-987654321 trusts https://token.actions.githubusercontent.com
          ✓ gcp.provider-condition  only accepts octo-org/site (id 987654321)
          ✓ gcp.service-account     github-987654321@demo-project.iam.gserviceaccount.com exists
          ✓ gcp.sa-keys             no user-managed keys
          ✓ gcp.project-roles       1 role on demo-project
          ✓ gcp.extra-roles         no roles beyond the requested ones
          ✓ gcp.wi-user             octo-org/site can act as github-987654321@demo-project.iam.gserviceaccount.com
          ✓ gcp.wi-user-broad       only this repository can act as the service account

        GitHub
          ✓ gh.repo                 octo-org/site (id 987654321)
          ✓ gh.variables            FIREBASE_WIF_PROVIDER and FIREBASE_WIF_SERVICE_ACCOUNT match
          ✓ gh.environment          production only deploys from main
          ✓ gh.legacy-secrets       no service account key or token secrets
          ✓ gh.oidc-sub             default sub template; longest sub is about 41 bytes
          - gh.workflows            no workflow deploys to Firebase yet

        0 failed, 0 warnings, 20 passed, 1 skipped
      "
    `);
  });

  it('exits 1 with fixes when checks fail', async () => {
    const fakes = createConfiguredFakes();
    fakes.github.state.repos['octo-org/site']!.variables = {};
    const { code, stdout } = await cli(['status', '--repo', 'octo-org/site'], fakes);
    expect(code).toBe(1);
    expect(stdout).toContain('✗ gh.variables');
    expect(stdout).toContain('fix: firebase-wif setup');
    expect(stdout).toContain('  1 failed, 0 warnings, 19 passed, 1 skipped');
  });

  it('prints JSON', async () => {
    const { code, stdout } = await cli(['--json', '--no-environment'], createConfiguredFakes());
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.context.environment).toBe(false);
    expect(report.checks.find((c: { id: string }) => c.id === 'gh.environment').status).toBe('skipped');
  });

  it('passes flags through', async () => {
    const fakes = createConfiguredFakes();
    const { stdout } = await cli(['--json', '--preset', 'hosting', '--preset', 'firestore', '--role', 'roles/datastore.viewer', '--provider', 'other-provider'], fakes);
    const report = JSON.parse(stdout);
    expect(report.context.presets).toEqual(['hosting', 'firestore']);
    expect(report.context.roles).toContain('roles/datastore.viewer');
    expect(report.context.provider).toMatch(/providers\/other-provider$/);
  });

  it('reports usage errors with exit code 2', async () => {
    const fakes = createConfiguredFakes();
    expect((await cli(['--nope'], fakes)).code).toBe(2);
    expect((await cli(['deploy'], fakes)).code).toBe(2);
    expect((await cli(['setup'], fakes)).code).toBe(2);
    expect((await cli(['--preset', 'database'], fakes)).code).toBe(2);
    expect((await cli(['--role', 'owner'], fakes)).code).toBe(2);
    expect((await cli(['--help'], fakes)).code).toBe(0);
  });

  it('exits 3 without Google credentials', async () => {
    const { code, stderr } = await cli([], createConfiguredFakes(), {
      googleClient: async () => {
        throw new FirebaseWifError('NO_GOOGLE_CREDENTIALS', 'No Google Cloud credentials found.', { fix: 'gcloud auth login' });
      },
    });
    expect(code).toBe(3);
    expect(stderr).toBe('No Google Cloud credentials found.\n  fix: gcloud auth login\n');
  });

  it('exits 3 when the project is not accessible', async () => {
    const { code, stdout } = await cli(['--json', '--project', 'missing-project'], createConfiguredFakes());
    expect(code).toBe(3);
    expect(JSON.parse(stdout).error.code).toBe('PROJECT_NOT_FOUND');
  });
});
