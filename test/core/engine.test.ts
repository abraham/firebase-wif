import { afterEach, describe, expect, it, vi } from 'vitest';
import { CROSS_PROJECT_PERMISSIONS, SETUP_PERMISSIONS } from '../../src/core/engine.js';
import { desiredAttributeCondition, desiredAttributeMapping, ISSUER } from '../../src/core/naming.js';
import { plan, setup, status } from '../../src/index.js';
import type { ApplyResult, Options, ProgressEvent, SetupResult, StatusReport } from '../../src/index.js';
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
    expect(planned.context).toEqual(report.context);
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

const noSleep = async () => {};

const setupWith = (fakes: ConfiguredFakes, extra: Partial<Parameters<typeof setup>[0]> = {}) =>
  setup({ ...fakes.options, google: fakes.google, github: fakes.github, sleep: noSleep, ...extra });

const applied = (result: SetupResult): ApplyResult => {
  if ('cancelled' in result) throw new Error('setup was cancelled');
  return result;
};

const writes = (fakes: ConfiguredFakes) =>
  [...fakes.google.calls, ...fakes.github.calls].filter(
    (c) => c.method !== 'GET' && !/:(getIamPolicy|testIamPermissions)$/.test(c.url),
  );

const emptyProject = (fakes: ConfiguredFakes) => {
  const project = fakes.google.state.projects[0]!;
  project.enabledServices = [];
  project.iamPolicy = { bindings: [] };
  fakes.google.state.pools = {};
  fakes.google.state.providers = {};
  fakes.google.state.serviceAccounts = {};
  const repo = fakes.github.state.repos['octo-org/site']!;
  repo.variables = {};
  repo.environments = {};
};

describe('setup', () => {
  it('sets up an empty project and repo, and a second run changes nothing', async () => {
    const fakes = createConfiguredFakes();
    emptyProject(fakes);
    const events: ProgressEvent[] = [];

    const result = applied(await setupWith(fakes, { onEvent: (event) => events.push(event) }));

    // The IAM API was off, so the plan couldn't see the pool, provider, or service account; apply re-reads.
    expect(result.applied.map((c) => `${c.resource} ${c.action}`)).toEqual([
      'gcp.apis enable',
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
    expect(result.manual).toEqual([]);
    expect(result.status.ok).toBe(true);
    expect(result.status.changes).toEqual([]);
    expect(events.filter((e) => e.type === 'change:done')).toHaveLength(result.applied.length);
    expect(events.filter((e) => e.type === 'change:start')).toHaveLength(result.applied.length);

    expect(fakes.google.state.providers[fakes.names.provider]).toMatchObject({
      attributeMapping: desiredAttributeMapping(),
      attributeCondition: desiredAttributeCondition(987654321, 1234567),
      oidc: { issuerUri: ISSUER },
      displayName: 'GitHub octo-org/site',
    });
    expect(fakes.google.state.serviceAccounts[fakes.names.serviceAccount]).toMatchObject({
      displayName: 'GitHub Actions: octo-org/site',
      description: 'Managed by firebase-wif for octo-org/site (987654321)',
    });
    const repo = fakes.github.state.repos['octo-org/site']!;
    expect(repo.variables).toEqual({ FIREBASE_WIF_PROVIDER: fakes.names.provider, FIREBASE_WIF_SERVICE_ACCOUNT: fakes.names.serviceAccount });
    expect(repo.environments!.production).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branchPolicies: ['main'],
    });

    fakes.google.calls.length = 0;
    fakes.github.calls.length = 0;
    const again = applied(await setupWith(fakes));
    expect(again.applied).toEqual([]);
    expect(writes(fakes)).toEqual([]);
    expect((await plan({ ...fakes.options, google: fakes.google, github: fakes.github })).changes).toEqual([]);
  });

  it('restores soft-deleted pools and providers, then repairs the provider', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.pools[fakes.names.pool]!.state = 'DELETED';
    Object.assign(fakes.google.state.providers[fakes.names.provider]!, {
      state: 'DELETED',
      disabled: true,
      attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.actor': 'assertion.actor' },
    });

    const result = applied(await setupWith(fakes));
    expect(result.applied.map((c) => c.description)).toEqual([
      'restore deleted workload identity pool github',
      'restore deleted provider github-987654321',
      're-enable provider github-987654321',
      'map attribute.repository_id on provider github-987654321',
    ]);
    expect(fakes.google.state.providers[fakes.names.provider]!.attributeMapping).toEqual({
      'google.subject': 'assertion.sub',
      'attribute.actor': 'assertion.actor',
      'attribute.repository_id': 'assertion.repository_id',
    });
    expect(result.status.ok).toBe(true);
  });

  it('tightens a name-only provider condition and re-enables what was disabled', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = "assertion.repository == 'octo-org/site'";
    fakes.google.state.pools[fakes.names.pool]!.disabled = true;
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.disabled = true;

    const result = applied(await setupWith(fakes));
    expect(result.applied.map((c) => `${c.resource} ${c.action}`)).toEqual([
      'gcp.pool update',
      'gcp.provider-condition update',
      'gcp.service-account enable',
    ]);
    expect(fakes.google.state.providers[fakes.names.provider]!.attributeCondition).toBe(desiredAttributeCondition(987654321, 1234567));
    expect(result.status.ok).toBe(true);
  });

  it('grants the deploy account on the functions runtime account only', async () => {
    const fakes = createConfiguredFakes({ presets: ['functions'] });
    const runtime = fakes.google.state.serviceAccounts['123456789012-compute@developer.gserviceaccount.com']!;
    runtime.iamPolicy = { bindings: [{ role: 'roles/viewer', members: ['user:a@example.com'] }] };

    const result = applied(await setupWith(fakes, { presets: ['functions'] }));
    expect(result.applied.map((c) => c.resource)).toEqual(['gcp.runtime-sa-user']);
    expect(runtime.iamPolicy!.bindings).toEqual([
      { role: 'roles/viewer', members: ['user:a@example.com'] },
      { role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${fakes.names.serviceAccount}`] },
    ]);
    expect(fakes.google.state.projects[0]!.iamPolicy.bindings!.map((b) => b.role)).not.toContain('roles/iam.serviceAccountUser');
  });

  it('keeps conditional bindings, other members, and the policy version', async () => {
    const fakes = createConfiguredFakes();
    const member = `serviceAccount:${fakes.names.serviceAccount}`;
    const conditional = { role: 'roles/firebasehosting.admin', members: [member], condition: { expression: 'false' } };
    fakes.google.state.projects[0]!.iamPolicy = {
      version: 3,
      etag: 'BwX7',
      bindings: [conditional, { role: 'roles/firebasehosting.admin', members: ['user:a@example.com'] }],
    };

    applied(await setupWith(fakes));
    expect(fakes.google.state.projects[0]!.iamPolicy).toEqual({
      version: 3,
      etag: 'BwX8',
      bindings: [conditional, { role: 'roles/firebasehosting.admin', members: ['user:a@example.com', member] }],
    });
  });

  it('retries IAM writes while a new service account propagates', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    fakes.google.state.projects[0]!.iamPolicy = { bindings: [] };
    fakes.google.state.failures = [{ url: ':setIamPolicy', status: 400, message: 'member does not exist', times: 2 }];
    const retries: ProgressEvent[] = [];
    const sleeps: number[] = [];

    const result = applied(
      await setupWith(fakes, {
        sleep: async (ms) => void sleeps.push(ms),
        onEvent: (event) => event.type === 'retry' && retries.push(event),
      }),
    );
    expect(retries).toEqual([
      { type: 'retry', reason: 'update the IAM policy of demo-project', attempt: 1, delayMs: 5000 },
      { type: 'retry', reason: 'update the IAM policy of demo-project', attempt: 2, delayMs: 5000 },
    ]);
    expect(sleeps).toEqual([5000, 5000]);
    expect(result.status.ok).toBe(true);
  });

  it("doesn't retry 400s for an existing service account", async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.projects[0]!.iamPolicy = { bindings: [] };
    fakes.google.state.failures = [{ url: ':setIamPolicy', status: 400, message: 'bad request' }];
    await expect(setupWith(fakes)).rejects.toMatchObject({
      code: 'APPLY_FAILED',
      details: { failed: { resource: 'gcp.project-roles' }, applied: [] },
    });
  });

  it('retries etag conflicts', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy = { bindings: [] };
    fakes.google.state.failures = [{ url: ':setIamPolicy', status: 409, times: 3 }];
    const delays: number[] = [];

    const result = applied(await setupWith(fakes, { onEvent: (e) => e.type === 'retry' && delays.push(e.delayMs) }));
    expect(delays).toHaveLength(3);
    delays.forEach((delay, i) => {
      expect(delay).toBeGreaterThanOrEqual(1000 * (i + 1));
      expect(delay).toBeLessThan(1000 * (i + 1) + 500);
    });
    expect(result.status.ok).toBe(true);
  });

  it('gives up after five retries', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy = { bindings: [] };
    fakes.google.state.failures = [{ url: ':setIamPolicy', status: 409, times: 6 }];
    await expect(setupWith(fakes)).rejects.toMatchObject({ code: 'APPLY_FAILED', details: { failed: { resource: 'gcp.wi-user' } } });
  });

  it('polls long-running operations and times out after 60 seconds', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.pools[fakes.names.pool];
    fakes.google.state.pendingPolls = 2;
    const waits: ProgressEvent[] = [];
    const sleeps: number[] = [];

    applied(
      await setupWith(fakes, {
        sleep: async (ms) => void sleeps.push(ms),
        onEvent: (event) => event.type === 'operation:wait' && waits.push(event),
      }),
    );
    expect(waits).toEqual([
      { type: 'operation:wait', name: 'set up workload identity pool github', attempt: 1 },
      { type: 'operation:wait', name: 'set up workload identity pool github', attempt: 2 },
    ]);
    expect(sleeps).toEqual([2000, 2000]);

    delete fakes.google.state.pools[fakes.names.pool];
    fakes.google.state.pendingPolls = 31;
    await expect(setupWith(fakes)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('stops when the signal aborts', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.pools[fakes.names.pool];
    fakes.google.state.pendingPolls = 5;
    const controller = new AbortController();

    await expect(setupWith(fakes, { signal: controller.signal, sleep: async () => controller.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fakes.google.calls.filter((c) => c.url.includes('/operations/'))).toEqual([]);
  });

  it("prunes only a managed account's unconditional extra roles", async () => {
    const fakes = createConfiguredFakes();
    const member = `serviceAccount:${fakes.names.serviceAccount}`;
    const conditional = { role: 'roles/viewer', members: [member], condition: { expression: 'false' } };
    fakes.google.state.projects[0]!.iamPolicy.bindings!.push(
      { role: 'roles/editor', members: [member, 'user:a@example.com'] },
      { role: 'roles/firebase.admin', members: [member] },
      conditional,
    );

    expect((await plan({ ...fakes.options, google: fakes.google, github: fakes.github })).changes).toEqual([]);
    const planned = await plan({ ...fakes.options, google: fakes.google, github: fakes.github, prune: true });
    expect(planned.changes.map((c) => c.description)).toEqual([
      `remove roles/editor on demo-project from ${fakes.names.serviceAccount}`,
      `remove roles/firebase.admin on demo-project from ${fakes.names.serviceAccount}`,
    ]);

    const result = applied(await setupWith(fakes, { prune: true }));
    expect(result.applied.map((c) => c.action)).toEqual(['unbind', 'unbind']);
    expect(fakes.google.state.projects[0]!.iamPolicy.bindings).toEqual([
      { role: 'roles/firebasehosting.admin', members: [member] },
      { role: 'roles/editor', members: ['user:a@example.com'] },
      conditional,
    ]);
    expect(check(result.status, 'gcp.extra-roles').status).toBe('pass');
  });

  it('leaves an unmanaged account alone when pruning', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.description = 'made by hand';
    fakes.google.state.projects[0]!.iamPolicy.bindings!.push({ role: 'roles/editor', members: [`serviceAccount:${fakes.names.serviceAccount}`] });

    const result = applied(await setupWith(fakes, { prune: true }));
    expect(result.applied).toEqual([]);
    expect(check(result.status, 'gcp.extra-roles')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining("not pruned: firebase-wif doesn't manage this service account"),
    });
  });

  it('refuses to write to Google Cloud without the permissions it needs', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.projects[0]!.grantedPermissions = [];
    delete fakes.google.state.pools[fakes.names.pool];

    await expect(setupWith(fakes)).rejects.toMatchObject({
      code: 'MISSING_PERMISSIONS',
      details: { missingPermissions: [...SETUP_PERMISSIONS] },
    });
    const planned = await plan({ ...fakes.options, google: fakes.google, github: fakes.github });
    await expect(planned.apply()).rejects.toMatchObject({ code: 'MISSING_PERMISSIONS' });
    expect(writes(fakes)).toEqual([]);

    // GitHub-only changes don't need Google Cloud permissions.
    fakes.google.state.pools[fakes.names.pool] = { state: 'ACTIVE' };
    fakes.github.state.repos['octo-org/site']!.variables = {};
    expect(applied(await setupWith(fakes)).applied.map((c) => c.resource)).toEqual(['gh.variables', 'gh.variables']);
  });

  it('can be cancelled before anything is written', async () => {
    const fakes = createConfiguredFakes();
    emptyProject(fakes);
    const result = await setupWith(fakes, { confirm: async (p) => p.changes.length === 0 });
    expect(result).toMatchObject({ cancelled: true, plan: { changes: expect.any(Array) } });
    expect(writes(fakes)).toEqual([]);
  });

  it('leaves GitHub changes to the user without admin access', async () => {
    const fakes = createConfiguredFakes();
    const repo = fakes.github.state.repos['octo-org/site']!;
    repo.permissions = { admin: false };
    repo.variables = {};

    const report = await run(fakes);
    expect(check(report, 'gh.variables')).toMatchObject({ status: 'fail', fix: expect.stringContaining('repo admin') });
    expect(report.changes.every((c) => c.manual)).toBe(true);

    const result = applied(await setupWith(fakes));
    expect(result.applied).toEqual([]);
    expect(result.manual.map((c) => c.description)).toEqual([
      `set repo variable FIREBASE_WIF_PROVIDER to ${fakes.names.provider}`,
      `set repo variable FIREBASE_WIF_SERVICE_ACCOUNT to ${fakes.names.serviceAccount}`,
    ]);
    expect(writes(fakes)).toEqual([]);
  });

  it('preserves environment reviewers and wait timers', async () => {
    const fakes = createConfiguredFakes();
    fakes.github.state.repos['octo-org/site']!.environments = {
      production: { deployment_branch_policy: null, branchPolicies: ['release'], waitTimer: 30, reviewers: [{ type: 'User', id: 1 }] },
    };

    const result = applied(await setupWith(fakes));
    expect(result.applied.map((c) => c.description)).toEqual(['limit production to selected branches', 'allow main to deploy to production']);
    expect(fakes.github.state.repos['octo-org/site']!.environments!.production).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branchPolicies: ['release', 'main'],
      waitTimer: 30,
      reviewers: [{ type: 'User', id: 1 }],
      preventSelfReview: false,
    });
  });

  it('explains org policies that block GitHub as an issuer', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.providers[fakes.names.provider];
    fakes.google.state.allowedIssuers = ['https://gitlab.com'];
    await expect(setupWith(fakes)).rejects.toMatchObject({
      code: 'ORG_POLICY_BLOCKS_ISSUER',
      fix: expect.stringContaining(ISSUER),
      details: { failed: { resource: 'gcp.provider' } },
    });
  });

  it('says what was already applied when a step fails', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.pools[fakes.names.pool];
    fakes.google.state.projects[0]!.iamPolicy = { bindings: [] };
    fakes.google.state.failures = [{ url: ':setIamPolicy', status: 403, message: 'Permission denied' }];

    const error = await setupWith(fakes).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'APPLY_FAILED',
      message:
        "Couldn't grant roles/firebasehosting.admin on demo-project to github-987654321@demo-project.iam.gserviceaccount.com (403): Permission denied. Already applied: create workload identity pool github.",
      details: { applied: [{ resource: 'gcp.pool' }] },
    });
    // Re-running picks up where it stopped.
    expect(applied(await setupWith(fakes)).status.ok).toBe(true);
  });

  it('adopts a legacy setup only when asked', async () => {
    const fakes = createConfiguredFakes();
    const legacyProvider = 'projects/123456789012/locations/global/workloadIdentityPools/github/providers/github-actions';
    const legacyAccount = 'github-deploy@demo-project.iam.gserviceaccount.com';
    const principal = fakes.names.principal;
    fakes.google.state.providers = {
      [legacyProvider]: { ...fakes.google.state.providers[fakes.names.provider]!, attributeCondition: "assertion.repository == 'octo-org/site'" },
    };
    fakes.google.state.serviceAccounts = {
      [legacyAccount]: { projectId: 'demo-project', iamPolicy: { bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [principal] }] } },
    };
    fakes.google.state.projects[0]!.iamPolicy = { bindings: [{ role: 'roles/firebasehosting.admin', members: [`serviceAccount:${legacyAccount}`] }] };
    const repo = fakes.github.state.repos['octo-org/site']!;
    repo.variables = { GCP_WIF_PROVIDER: legacyProvider, GCP_DEPLOY_SA: legacyAccount };

    const fresh = await plan({ ...fakes.options, google: fakes.google, github: fakes.github });
    expect(fresh.context.adopted).toBeUndefined();
    expect(fresh.changes.map((c) => `${c.resource} ${c.action}`)).toContain('gcp.provider create');

    const declined = await plan({ ...fakes.options, google: fakes.google, github: fakes.github, adopt: async () => false });
    expect(declined.context.adopted).toBeUndefined();

    const offers: unknown[] = [];
    const result = applied(
      await setupWith(fakes, {
        adopt: async (candidate) => {
          offers.push(candidate);
          return true;
        },
      }),
    );
    expect(offers).toEqual([
      { provider: legacyProvider, serviceAccount: legacyAccount, variables: { provider: 'GCP_WIF_PROVIDER', serviceAccount: 'GCP_DEPLOY_SA' } },
    ]);
    expect(result.applied.map((c) => `${c.resource} ${c.action}`)).toEqual(['gcp.provider-condition update', 'gh.variables set', 'gh.variables set']);
    expect(result.status.ok).toBe(true);
    expect(result.status.context.provider).toBe(legacyProvider);
    expect(repo.variables).toEqual({
      GCP_WIF_PROVIDER: legacyProvider,
      GCP_DEPLOY_SA: legacyAccount,
      FIREBASE_WIF_PROVIDER: legacyProvider,
      FIREBASE_WIF_SERVICE_ACCOUNT: legacyAccount,
    });
    expect(fakes.google.state.providers[legacyProvider]!.attributeCondition).toBe(desiredAttributeCondition(987654321, 1234567));
  });
});

const STAGING = { projectId: 'staging-project', projectNumber: '222222222222' };

const addStaging = (fakes: ConfiguredFakes) => {
  const staging = { ...STAGING, enabledServices: [] as string[], iamPolicy: { bindings: [] } };
  fakes.google.state.projects.push(staging);
  return staging;
};

describe('multiple projects', () => {
  it("reuses the home project's trust chain and only reconciles APIs and roles", async () => {
    const fakes = createConfiguredFakes();
    const staging = addStaging(fakes);
    const options = { ...fakes.options, projectId: STAGING.projectId };

    const report = await run(fakes, options);
    expect(report.context).toMatchObject({
      projectId: 'staging-project',
      homeProjectId: 'demo-project',
      pool: fakes.names.pool,
      provider: fakes.names.provider,
      serviceAccount: fakes.names.serviceAccount,
    });
    expect(report.context.apis).not.toContain('sts.googleapis.com');
    expect(report.context.apis).not.toContain('iamcredentials.googleapis.com');
    for (const id of ['gcp.pool', 'gcp.provider', 'gcp.provider-condition', 'gcp.service-account', 'gcp.wi-user', 'gh.variables', 'gh.environment']) {
      expect(check(report, id), id).toMatchObject({ status: 'skipped', message: 'shared from demo-project; check it with --project demo-project' });
    }
    expect(report.changes.map((c) => `${c.resource} ${c.action}`)).toEqual(['gcp.apis enable', 'gcp.project-roles bind']);
    expect(fakes.google.calls).toContainEqual(
      expect.objectContaining({ url: expect.stringContaining('staging-project:testIamPermissions'), body: { permissions: [...CROSS_PROJECT_PERMISSIONS] } }),
    );
    expectConsistent(report);

    const result = applied(await setupWith(fakes, options));
    expect(result.applied.map((c) => c.description)).toEqual([
      'enable cloudresourcemanager.googleapis.com, firebasehosting.googleapis.com, iam.googleapis.com',
      `grant roles/firebasehosting.admin on staging-project to ${fakes.names.serviceAccount}`,
    ]);
    expect(staging.iamPolicy).toEqual({ version: 1, etag: 'BwX1', bindings: [{ role: 'roles/firebasehosting.admin', members: [`serviceAccount:${fakes.names.serviceAccount}`] }] });
    expect(Object.keys(fakes.google.state.pools)).toEqual([fakes.names.pool]);
    expect(Object.keys(fakes.google.state.serviceAccounts)).toEqual([fakes.names.serviceAccount]);
    expect(fakes.github.state.repos['octo-org/site']!.variables).toEqual({
      FIREBASE_WIF_PROVIDER: fakes.names.provider,
      FIREBASE_WIF_SERVICE_ACCOUNT: fakes.names.serviceAccount,
    });
    expect(result.status.ok).toBe(true);
    expect((await plan({ ...options, google: fakes.google, github: fakes.github })).changes).toEqual([]);
  });

  it('takes the home chain from options without GitHub access', async () => {
    const fakes = createConfiguredFakes();
    addStaging(fakes);
    const home = { provider: fakes.names.provider, serviceAccount: fakes.names.serviceAccount };
    vi.stubGlobal('fetch', async (url: string) => {
      const repo = await fakes.github.request<unknown>('GET', new URL(url).pathname);
      return new Response(JSON.stringify(repo), { status: 200 });
    });

    const result = applied(await setupWith(fakes, { projectId: STAGING.projectId, github: false, home }));
    expect(result.status.context.homeProjectId).toBe('demo-project');
    expect(result.manual).toEqual([]);
    expect(result.status.ok).toBe(true);

    // In the home project itself, `home` just names the chain to check.
    const own = await run(fakes, { github: false, home });
    expect(own.context.homeProjectId).toBe('demo-project');
    expect(check(own, 'gcp.pool').status).toBe('pass');
  });

  it('starts an independent chain when names are passed', async () => {
    const fakes = createConfiguredFakes();
    addStaging(fakes);
    const report = await run(fakes, { projectId: STAGING.projectId, names: { serviceAccount: 'deployer' } });
    expect(report.context).toMatchObject({
      homeProjectId: 'staging-project',
      serviceAccount: 'deployer@staging-project.iam.gserviceaccount.com',
      provider: 'projects/222222222222/locations/global/workloadIdentityPools/github/providers/github-987654321',
    });
  });

  it('rejects an invalid home', async () => {
    const fakes = createConfiguredFakes();
    await expect(run(fakes, { home: { provider: 'github', serviceAccount: fakes.names.serviceAccount } })).rejects.toMatchObject({
      code: 'INVALID_NAME',
    });
    await expect(run(fakes, { home: { provider: fakes.names.provider, serviceAccount: 'nope' } })).rejects.toMatchObject({
      code: 'INVALID_NAME',
    });
  });

  it("lets the deploy account act as the other project's functions runtime", async () => {
    const fakes = createConfiguredFakes({ presets: ['functions'] });
    addStaging(fakes);
    const runtime = '222222222222-compute@developer.gserviceaccount.com';
    fakes.google.state.serviceAccounts[runtime] = { projectId: STAGING.projectId, iamPolicy: {} };

    const result = applied(await setupWith(fakes, { projectId: STAGING.projectId, presets: ['functions'] }));
    expect(result.applied.map((c) => c.resource)).toEqual(['gcp.apis', 'gcp.project-roles', 'gcp.project-roles', 'gcp.runtime-sa-user']);
    expect(fakes.google.state.serviceAccounts[runtime]!.iamPolicy!.bindings).toEqual([
      { role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${fakes.names.serviceAccount}`] },
    ]);
    expect(result.status.ok).toBe(true);
  });
});
