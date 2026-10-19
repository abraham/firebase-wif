import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETUP_PERMISSIONS } from '../../src/core/engine.js';
import { plan, status } from '../../src/index.js';
import type { Options, StatusReport } from '../../src/index.js';
import { createConfiguredFakes, type ConfiguredFakes } from '../../src/testing/index.js';

const RESOURCE_IDS = [
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
];

const run = (fakes: ConfiguredFakes, extra: Partial<Options> = {}) =>
  status({ ...fakes.options, google: fakes.google, github: fakes.github, ...extra });

const check = (report: StatusReport, id: string) => {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

/** A reconcile check reports a problem exactly when its plan has changes. */
const expectConsistent = (report: StatusReport) => {
  for (const c of report.checks.filter((c) => RESOURCE_IDS.includes(c.id))) {
    const changes = report.changes.filter((change) => change.resource === c.id && !change.manual);
    expect(['fail', 'warn'].includes(c.status), `${c.id}: ${c.status} with ${changes.length} changes`).toBe(changes.length > 0);
  }
  expect(report.ok).toBe(!report.checks.some((c) => c.status === 'fail'));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('status', () => {
  it('passes for a fully set up repo and project', async () => {
    const fakes = createConfiguredFakes();
    const report = await run(fakes);

    expect(report.ok).toBe(true);
    expect(report.changes).toEqual([]);
    expect(report.checks.filter((c) => c.status !== 'pass' && !c.id.startsWith('local.')).map((c) => c.id)).toEqual(['gh.workflows']);
    expect(report.context).toMatchObject({
      projectNumber: '123456789012',
      repoId: 987654321,
      pool: fakes.names.pool,
      provider: fakes.names.provider,
      serviceAccount: fakes.names.serviceAccount,
      roles: ['roles/firebasehosting.admin'],
      environment: { name: 'production', branch: 'main' },
    });
    expect(report.preflight).toEqual({ missingPermissions: [], githubAdmin: true });
    expect(fakes.google.calls).toContainEqual(expect.objectContaining({ body: { permissions: [...SETUP_PERMISSIONS] } }));
    expectConsistent(report);
    // Status only reads.
    expect([...fakes.google.calls, ...fakes.github.calls].filter((c) => /setIamPolicy|PATCH|PUT/.test(`${c.method} ${c.url}`))).toEqual([]);
  });

  it('plans everything for an empty project', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.pools = {};
    fakes.google.state.providers = {};
    fakes.google.state.serviceAccounts = {};
    fakes.google.state.projects[0]!.iamPolicy = { bindings: [] };
    const repo = fakes.github.state.repos['octo-org/site']!;
    repo.variables = {};
    repo.environments = {};

    const report = await run(fakes);
    expect(report.ok).toBe(false);
    expectConsistent(report);
    expect(report.changes.map((c) => `${c.resource} ${c.action}`)).toEqual([
      'gcp.pool create',
      'gcp.provider create',
      'gcp.service-account create',
      'gcp.project-roles bind',
      'gcp.wi-user bind',
      'gh.variables set',
      'gh.variables set',
      'gh.environment create',
      'gh.environment create',
    ]);
    expect(check(report, 'gcp.provider-condition')).toMatchObject({ status: 'skipped' });
    expect(check(report, 'gh.environment').status).toBe('warn');

    const planned = await plan({ ...fakes.options, google: fakes.google, github: fakes.github });
    expect(planned.changes).toEqual(report.changes);
    await expect(planned.apply()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('blocks IAM checks while the IAM API is disabled', async () => {
    const fakes = createConfiguredFakes();
    const project = fakes.google.state.projects[0]!;
    project.enabledServices = project.enabledServices.filter((api) => api !== 'iam.googleapis.com');

    const report = await run(fakes);
    expect(check(report, 'gcp.apis')).toMatchObject({ status: 'fail', message: 'enable iam.googleapis.com' });
    for (const id of ['gcp.pool', 'gcp.provider', 'gcp.service-account', 'gcp.wi-user']) {
      expect(check(report, id)).toMatchObject({ status: 'skipped', message: expect.stringContaining('blocked by gcp.apis') });
    }
    expectConsistent(report);
  });

  it('restores soft-deleted pools and providers', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.pools[fakes.names.pool]!.state = 'DELETED';
    fakes.google.state.providers[fakes.names.provider]!.state = 'DELETED';

    const report = await run(fakes);
    expect(report.changes.map((c) => `${c.resource} ${c.action}`)).toEqual(['gcp.pool undelete', 'gcp.provider undelete']);
    expectConsistent(report);
  });

  it('tightens loose provider conditions', async () => {
    const fakes = createConfiguredFakes();
    const provider = fakes.google.state.providers[fakes.names.provider]!;

    delete provider.attributeCondition;
    expect((await run(fakes)).changes.map((c) => c.description)).toEqual([
      'limit provider github-987654321 to octo-org/site (no attribute condition)',
    ]);

    provider.attributeCondition = "assertion.repository == 'octo-org/site'";
    const report = await run(fakes);
    expect(report.changes.map((c) => c.description)).toEqual([
      'pin provider github-987654321 to repository ID 987654321 instead of the name octo-org/site',
    ]);
    expectConsistent(report);

    // setup-wif.sh pins only the repository ID, which is enough.
    provider.attributeCondition = "assertion.repository_id == '987654321'";
    expect((await run(fakes)).ok).toBe(true);
  });

  it("refuses to re-point another repository's provider", async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = "assertion.repository_id == '1'";

    const report = await run(fakes);
    expect(check(report, 'gcp.provider-condition')).toMatchObject({ status: 'fail', fix: expect.stringContaining('--provider') });
    await expect(plan({ ...fakes.options, google: fakes.google, github: fakes.github })).rejects.toMatchObject({
      code: 'PROVIDER_OWNED_BY_OTHER_REPO',
    });
  });

  it('refuses providers for other issuers', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.providers[fakes.names.provider]!.oidc = { issuerUri: 'https://gitlab.com' };
    expect(check(await run(fakes), 'gcp.provider')).toMatchObject({ status: 'fail', message: expect.stringContaining('gitlab.com') });
  });

  it('notices missing mappings, roles, and bindings', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.providers[fakes.names.provider]!.attributeMapping = { 'google.subject': 'assertion.sub' };
    fakes.google.state.projects[0]!.iamPolicy = {
      bindings: [{ role: 'roles/firebasehosting.admin', members: [`serviceAccount:${fakes.names.serviceAccount}`], condition: { expression: 'false' } }],
    };
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy = { bindings: [] };
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.disabled = true;

    const report = await run(fakes);
    expect(report.changes.map((c) => c.description)).toEqual([
      'map attribute.repository_id on provider github-987654321',
      'enable service account github-987654321@demo-project.iam.gserviceaccount.com',
      'grant roles/firebasehosting.admin on demo-project to github-987654321@demo-project.iam.gserviceaccount.com',
      'let octo-org/site act as github-987654321@demo-project.iam.gserviceaccount.com (roles/iam.workloadIdentityUser)',
    ]);
    expectConsistent(report);
  });

  it('skips what it cannot read instead of failing', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.forbidden = ['/serviceAccounts/'];
    fakes.github.state.forbidden = ['/actions/'];

    const report = await run(fakes);
    for (const id of ['gcp.service-account', 'gcp.wi-user', 'gcp.sa-keys', 'gh.variables', 'gh.legacy-secrets', 'gh.oidc-sub']) {
      expect(check(report, id), id).toMatchObject({ status: 'skipped', message: expect.stringContaining('insufficient permission') });
    }
    expectConsistent(report);
  });

  it('reports advisory problems', async () => {
    const fakes = createConfiguredFakes();
    const account = fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!;
    account.keys = ['abc'];
    account.iamPolicy!.bindings!.push({
      role: 'roles/iam.workloadIdentityUser',
      members: ['principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/github/*'],
    });
    fakes.google.state.projects[0]!.iamPolicy.bindings!.push({
      role: 'roles/firebase.admin',
      members: [`serviceAccount:${fakes.names.serviceAccount}`],
    });
    fakes.google.state.projects[0]!.grantedPermissions = ['iam.serviceAccounts.create'];
    const repo = fakes.github.state.repos['octo-org/site']!;
    repo.secrets = ['FIREBASE_SERVICE_ACCOUNT_DEMO_PROJECT', 'NPM_TOKEN'];
    repo.permissions = { admin: false };

    const report = await run(fakes, { environment: { name: 'production', branch: 'b'.repeat(120) } });
    expect(report.ok).toBe(true);
    expect(check(report, 'gcp.sa-keys').status).toBe('warn');
    expect(check(report, 'gcp.extra-roles')).toMatchObject({ status: 'warn', fix: 'firebase-wif setup --prune' });
    expect(check(report, 'gcp.wi-user-broad')).toMatchObject({ status: 'warn', message: expect.stringContaining('/github/*') });
    expect(check(report, 'gcp.operator').status).toBe('warn');
    expect(report.preflight.missingPermissions).toHaveLength(8);
    expect(report.preflight.githubAdmin).toBe(false);
    expect(check(report, 'gh.repo').status).toBe('warn');
    expect(check(report, 'gh.legacy-secrets').message).toBe('FIREBASE_SERVICE_ACCOUNT_DEMO_PROJECT still set');
    expect(check(report, 'gh.oidc-sub').status).toBe('warn');
  });

  it('follows existing repo variables to adopted names', async () => {
    const fakes = createConfiguredFakes();
    const provider = 'projects/123456789012/locations/global/workloadIdentityPools/github/providers/github-actions';
    fakes.google.state.providers[provider] = fakes.google.state.providers[fakes.names.provider]!;
    fakes.github.state.repos['octo-org/site']!.variables = {
      GCP_WIF_PROVIDER: provider,
      GCP_DEPLOY_SA: fakes.names.serviceAccount,
    };

    const report = await run(fakes, { variables: { provider: 'GCP_WIF_PROVIDER', serviceAccount: 'GCP_DEPLOY_SA' } });
    expect(report.context.provider).toBe(provider);
    expect(report.ok).toBe(true);
  });

  it('checks the runtime service account for functions', async () => {
    const fakes = createConfiguredFakes({ presets: ['hosting', 'functions'] });
    expect(check(await run(fakes), 'gcp.runtime-sa-user').status).toBe('pass');

    fakes.google.state.serviceAccounts['123456789012-compute@developer.gserviceaccount.com']!.iamPolicy = {};
    const report = await run(fakes);
    expect(check(report, 'gcp.runtime-sa-user').status).toBe('fail');
    expectConsistent(report);

    delete fakes.google.state.serviceAccounts['123456789012-compute@developer.gserviceaccount.com'];
    expect(check(await run(fakes), 'gcp.runtime-sa-user')).toMatchObject({ status: 'skipped' });
  });

  it('turns GitHub changes into manual steps without GitHub credentials', async () => {
    const fakes = createConfiguredFakes();
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      const repo = await fakes.github.request<unknown>('GET', path);
      return new Response(JSON.stringify(repo), { status: 200 });
    });

    const report = await run(fakes, { github: false });
    expect(check(report, 'gh.variables').status).toBe('skipped');
    expect(report.changes.every((c) => c.manual)).toBe(true);
    expect(report.changes.map((c) => c.resource)).toEqual(['gh.variables', 'gh.variables', 'gh.environment', 'gh.environment']);
    expect(report.preflight.githubAdmin).toBeUndefined();
  });

  it('checks local files when given', async () => {
    const fakes = createConfiguredFakes();
    const report = await run(fakes, {
      local: {
        firebaseJson: { hosting: { public: '.' } },
        firebaserc: { projects: { default: 'other-project' } },
        workflows: {
          'deploy.yml': 'on: push\njobs:\n  deploy:\n    steps:\n      - uses: google-github-actions/auth@v3\n      - run: npx firebase deploy\n',
        },
      },
    });
    expect(check(report, 'local.firebase-json').status).toBe('pass');
    expect(check(report, 'local.project-match')).toMatchObject({ status: 'warn', message: expect.stringContaining('other-project') });
    expect(check(report, 'local.creds-ignored')).toMatchObject({ status: 'warn', message: expect.stringContaining('.gitignore') });
    expect(check(report, 'gh.workflows')).toMatchObject({ status: 'warn', message: expect.stringContaining('id-token') });
  });

  it('emits a check event per check', async () => {
    const fakes = createConfiguredFakes();
    const ids: string[] = [];
    const report = await run(fakes, { onEvent: (event) => event.type === 'check' && ids.push(event.check.id) });
    expect(ids.sort()).toEqual(report.checks.map((c) => c.id).sort());
  });

  it('throws for unknown projects, repos, and invalid names', async () => {
    const fakes = createConfiguredFakes();
    await expect(run(fakes, { projectId: 'missing-project' })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(run(fakes, { repo: 'octo-org/missing' })).rejects.toMatchObject({ code: 'REPO_NOT_FOUND' });
    await expect(run(fakes, { names: { provider: 'gcp-nope' } })).rejects.toMatchObject({ code: 'INVALID_NAME' });
    await expect(run(fakes, { roles: ['owner'] })).rejects.toMatchObject({ code: 'INVALID_NAME' });
  });
});
