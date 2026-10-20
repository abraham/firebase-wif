import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
    interactive: false,
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
    const { stdout } = await cli(
      [
        '--json',
        '--preset',
        'hosting',
        '--preset',
        'firestore',
        '--role',
        'roles/datastore.viewer',
        '--provider',
        'other-provider',
      ],
      fakes,
    );
    const report = JSON.parse(stdout);
    expect(report.context.presets).toEqual(['hosting', 'firestore']);
    expect(report.context.roles).toContain('roles/datastore.viewer');
    expect(report.context.provider).toMatch(/providers\/other-provider$/);

    const anyBranch = JSON.parse((await cli(['--json', '--environment', 'test', '--any-branch'], fakes)).stdout);
    expect(anyBranch.context.environment).toEqual({ name: 'test', branch: false });
  });

  it('reports usage errors with exit code 2', async () => {
    const fakes = createConfiguredFakes();
    expect((await cli(['--nope'], fakes)).code).toBe(2);
    expect((await cli(['deploy'], fakes)).code).toBe(2);
    expect((await cli(['status', '--yes'], fakes)).code).toBe(2);
    expect((await cli(['--any-branch', '--branch', 'main'], fakes)).code).toBe(2);
    expect((await cli(['--preset', 'database'], fakes)).code).toBe(2);
    expect((await cli(['--role', 'owner'], fakes)).code).toBe(2);
    expect((await cli(['--help'], fakes)).code).toBe(0);
  });

  it('exits 3 without Google credentials', async () => {
    const { code, stderr } = await cli([], createConfiguredFakes(), {
      googleClient: async () => {
        throw new FirebaseWifError('NO_GOOGLE_CREDENTIALS', 'No Google Cloud credentials found.', {
          fix: 'gcloud auth login',
        });
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

const brokenFakes = () => {
  const fakes = createConfiguredFakes();
  delete fakes.google.state.pools[fakes.names.pool];
  fakes.github.state.repos['octo-org/site']!.variables = {};
  return fakes;
};

const writes = (fakes: ConfiguredFakes) =>
  [...fakes.google.calls, ...fakes.github.calls].filter(
    (c) => c.method !== 'GET' && !/:(getIamPolicy|testIamPermissions)$/.test(c.url),
  );

describe('firebase-wif setup', () => {
  it('prints the plan with --dry-run and changes nothing', async () => {
    const fakes = brokenFakes();
    const { code, stdout } = await cli(['setup', '--dry-run'], fakes);
    expect(code).toBe(0);
    expect(stdout).toMatchInlineSnapshot(`
      "firebase-wif setup
        project  demo-project (#123456789012, from .firebaserc default)
        repo     octo-org/site (id 987654321, from git remote origin)

        Changes
          + create workload identity pool github
          + create provider github-987654321
          ~ set repo variable FIREBASE_WIF_PROVIDER to projects/123456789012/locations/global/workloadIdentityPools/github/providers/github-987654321
          ~ set repo variable FIREBASE_WIF_SERVICE_ACCOUNT to github-987654321@demo-project.iam.gserviceaccount.com
      "
    `);
    expect(writes(fakes)).toEqual([]);
  });

  it('applies with --yes and prints the final status', async () => {
    const fakes = brokenFakes();
    const { code, stdout } = await cli(['setup', '--yes'], fakes);
    expect(code).toBe(0);
    expect(stdout).toContain('  ✓ create workload identity pool github\n');
    expect(stdout).toContain('  ✓ set repo variable FIREBASE_WIF_SERVICE_ACCOUNT');
    expect(stdout).toContain('firebase-wif status');
    expect(stdout).toContain('  0 failed, 0 warnings, 20 passed, 1 skipped');
    expect(stdout).toContain('IAM changes can take a few minutes');
    expect((await cli(['status'], fakes)).code).toBe(0);
  });

  it('says when everything is already set up', async () => {
    const { code, stdout } = await cli(['setup'], createConfiguredFakes());
    expect(code).toBe(0);
    expect(stdout).toContain('  Already set up.\n');
    expect(stdout).not.toContain('firebase-wif status');
  });

  it('needs --yes when it cannot ask', async () => {
    const fakes = brokenFakes();
    const { code, stderr } = await cli(['setup'], fakes);
    expect(code).toBe(2);
    expect(stderr).toBe('Pass --yes to apply changes without a prompt.\n');
    expect(writes(fakes)).toEqual([]);
  });

  it('asks before applying', async () => {
    const questions: string[] = [];
    const declined = await cli(['setup'], brokenFakes(), {
      interactive: true,
      prompt: async (question) => (questions.push(question), false),
    });
    expect(declined.code).toBe(1);
    expect(declined.stdout).toContain('Cancelled; nothing changed.');
    expect(questions).toEqual(['Apply these changes?']);

    const accepted = await cli(['setup'], brokenFakes(), { interactive: true, prompt: async () => true });
    expect(accepted.code).toBe(0);
  });

  it('asks before adopting a legacy setup unless --adopt is passed', async () => {
    const legacy = () => {
      const fakes = createConfiguredFakes();
      fakes.github.state.repos['octo-org/site']!.variables = {
        GCP_WIF_PROVIDER: fakes.names.provider,
        GCP_DEPLOY_SA: fakes.names.serviceAccount,
      };
      return fakes;
    };
    const questions: string[] = [];
    const asked = await cli(['setup', '--dry-run'], legacy(), {
      interactive: true,
      prompt: async (question) => (questions.push(question), true),
    });
    expect(questions).toEqual([
      'Adopt projects/123456789012/locations/global/workloadIdentityPools/github/providers/github-987654321 and github-987654321@demo-project.iam.gserviceaccount.com from GCP_WIF_PROVIDER and GCP_DEPLOY_SA?',
    ]);
    expect(asked.stdout).toContain('  adopt    projects/123456789012');
    expect(asked.stdout).toContain('(from GCP_WIF_PROVIDER and GCP_DEPLOY_SA)');

    const fakes = legacy();
    const { code, stdout } = await cli(['setup', '--adopt', '--yes', '--json'], fakes);
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.applied.map((c: { resource: string }) => c.resource)).toEqual(['gh.variables', 'gh.variables']);
    expect(result.status.ok).toBe(true);
    expect(fakes.github.state.repos['octo-org/site']!.variables).toMatchObject({
      GCP_WIF_PROVIDER: fakes.names.provider,
    });

    // status follows the legacy variables, so it only reports the missing new ones.
    const report = JSON.parse((await cli(['status', '--json'], legacy())).stdout);
    expect(report.changes.map((c: { resource: string }) => c.resource)).toEqual(['gh.variables', 'gh.variables']);
  });

  it('prints the plan as JSON with --dry-run --json', async () => {
    const { code, stdout } = await cli(
      ['setup', '--dry-run', '--json', '--prune', '--role', 'roles/cloudscheduler.admin', '--preset', 'functions'],
      brokenFakes(),
    );
    expect(code).toBe(0);
    const planned = JSON.parse(stdout);
    expect(Object.keys(planned)).toEqual(['context', 'changes', 'preflight']);
    expect(planned.context.roles).toContain('roles/cloudscheduler.admin');
  });

  it('passes runtime service accounts through', async () => {
    const fakes = createConfiguredFakes();
    const { stdout } = await cli(
      [
        'setup',
        '--dry-run',
        '--json',
        '--preset',
        'functions',
        '--runtime-service-account',
        'runner@demo-project.iam.gserviceaccount.com',
      ],
      fakes,
    );
    expect(JSON.parse(stdout).context.runtimeServiceAccounts).toEqual(['runner@demo-project.iam.gserviceaccount.com']);
  });

  it('exits 3 without the permissions setup needs', async () => {
    const fakes = brokenFakes();
    fakes.google.state.projects[0]!.grantedPermissions = [];
    const { code, stderr } = await cli(['setup', '--yes'], fakes);
    expect(code).toBe(3);
    expect(stderr).toContain("You're missing permissions that setup needs");
    expect(stderr).toContain('fix: Ask a project owner to run firebase-wif setup.');
    expect(writes(fakes)).toEqual([]);
  });

  it('exits 1 when a provider belongs to another repository', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = "assertion.repository_id == '1'";
    const { code, stderr } = await cli(['setup', '--yes'], fakes);
    expect(code).toBe(1);
    expect(stderr).toContain('fix: Pass --provider');
  });

  it('exits 1 and says what was applied when a step fails', async () => {
    const fakes = brokenFakes();
    delete fakes.google.state.providers[fakes.names.provider];
    fakes.google.state.failures = [{ url: '/providers?', status: 500, message: 'backend error' }];
    const { code, stderr } = await cli(['setup', '--yes'], fakes);
    expect(code).toBe(1);
    expect(stderr).toContain(
      "Couldn't create provider github-987654321 (500): backend error. Already applied: create workload identity pool github.",
    );
  });

  it('lists manual steps without GitHub credentials', async () => {
    const fakes = brokenFakes();
    vi.stubGlobal('fetch', async (url: string) => {
      const repo = await fakes.github.request<unknown>('GET', new URL(url).pathname);
      return new Response(JSON.stringify(repo), { status: 200 });
    });
    try {
      const { code, stdout, stderr } = await cli(['setup', '--yes'], fakes, {
        githubClient: async () => {
          throw new FirebaseWifError('NO_GITHUB_CREDENTIALS', 'No GitHub credentials found.');
        },
      });
      expect(stderr).toContain('No GitHub credentials');
      expect(stdout).toContain('  Do by hand\n    - set repo variable FIREBASE_WIF_PROVIDER');
      expect(stdout).toContain('Do by hand:\n  - set repo variable FIREBASE_WIF_PROVIDER');
      // Without credentials the variables can't be checked, so they're skipped rather than failed.
      expect(stdout).toContain('- gh.variables');
      expect(code).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const aliasDir = async (projects: Record<string, string>) => {
  const root = await repoDir();
  await writeFile(join(root, '.firebaserc'), JSON.stringify({ projects }));
  return root;
};

const withStaging = (fakes: ConfiguredFakes) => {
  fakes.google.state.projects.push({
    projectId: 'staging-project',
    projectNumber: '222222222222',
    enabledServices: [],
    iamPolicy: { bindings: [] },
  });
  return fakes;
};

describe('--all-aliases', () => {
  it('checks every alias against the shared trust chain', async () => {
    const fakes = withStaging(createConfiguredFakes());
    const cwd = await aliasDir({ staging: 'staging-project', default: 'demo-project' });
    const { code, stdout } = await cli(['--all-aliases'], fakes, { cwd });
    expect(code).toBe(1);
    const [home, staging] = stdout.split('\nfirebase-wif status\n');
    expect(home).toContain('project  demo-project (#123456789012, from .firebaserc alias default)');
    expect(home).toContain('  0 failed, 0 warnings, 20 passed, 1 skipped');
    expect(staging).toContain('project  staging-project (#222222222222, from .firebaserc alias staging)');
    expect(staging).toContain('home     demo-project (shares its provider and service account)');
    expect(staging).toContain('- gcp.pool                shared from demo-project');
    expect(staging).toContain('\u2717 gcp.project-roles');
  });

  it('sets up the home project first, then grants roles in the others', async () => {
    const fakes = withStaging(createConfiguredFakes());
    emptyAll(fakes);
    const cwd = await aliasDir({ default: 'demo-project', staging: 'staging-project' });

    const dryRun = JSON.parse((await cli(['setup', '--all-aliases', '--dry-run', '--json'], fakes, { cwd })).stdout);
    expect(dryRun.map((entry: { alias: string }) => entry.alias)).toEqual(['default', 'staging']);
    expect(dryRun[1].context.homeProjectId).toBe('demo-project');
    expect(dryRun[1].changes.map((c: { resource: string }) => c.resource)).toEqual(['gcp.apis', 'gcp.project-roles']);

    const { code, stdout } = await cli(['setup', '--all-aliases', '--yes', '--json'], fakes, { cwd });
    expect(code).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.map((entry: { alias: string; status: { ok: boolean } }) => [entry.alias, entry.status.ok])).toEqual([
      ['default', true],
      ['staging', true],
    ]);
    expect(fakes.google.state.projects[1]!.iamPolicy.bindings).toEqual([
      { role: 'roles/firebasehosting.admin', members: [`serviceAccount:${fakes.names.serviceAccount}`] },
    ]);
    expect((await cli(['--all-aliases'], fakes, { cwd })).code).toBe(0);
  });

  it('stops at the first project that fails to run', async () => {
    const fakes = createConfiguredFakes();
    const cwd = await aliasDir({ default: 'missing-project', staging: 'demo-project' });
    const { code, stdout } = await cli(['--all-aliases', '--json'], fakes, { cwd });
    expect(code).toBe(3);
    expect(JSON.parse(stdout)).toEqual([
      { alias: 'default', error: expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }) },
    ]);
  });

  it('needs aliases and no --project', async () => {
    const fakes = createConfiguredFakes();
    expect((await cli(['--all-aliases', '--project', 'demo-project'], fakes)).code).toBe(2);
    const empty = await repoDir();
    await writeFile(join(empty, '.firebaserc'), '{}');
    const { code, stderr } = await cli(['--all-aliases'], fakes, { cwd: empty });
    expect(code).toBe(2);
    expect(stderr).toBe('--all-aliases needs project aliases in .firebaserc.\n');
  });
});

function emptyAll(fakes: ConfiguredFakes) {
  const project = fakes.google.state.projects[0]!;
  project.enabledServices = [];
  project.iamPolicy = { bindings: [] };
  fakes.google.state.pools = {};
  fakes.google.state.providers = {};
  fakes.google.state.serviceAccounts = {};
  fakes.github.state.repos['octo-org/site']!.variables = {};
  fakes.github.state.repos['octo-org/site']!.environments = {};
}
