import { describe, expect, it } from 'vitest';
import { RESOURCES, type Resource } from '../../src/core/resources.js';
import type { Runtime } from '../../src/core/runtime.js';
import { createConfiguredFakes, type ConfiguredFakes } from '../../src/testing/index.js';
import { runtimeFor } from '../helpers.js';

const resource = (id: string): Resource => RESOURCES.find((r) => r.id === id)!;

const evaluate = async (id: string, fakes: ConfiguredFakes, rt: Runtime) => resource(id).evaluate(rt);

const actions = (outcome: Awaited<ReturnType<Resource['evaluate']>>) =>
  outcome.kind === 'drift' ? outcome.changes.map((c) => `${c.action}: ${c.description}`) : outcome.kind;

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

describe('gcp.apis', () => {
  it('enables the disabled APIs in one change', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.enabledServices = ['iam.googleapis.com', 'sts.googleapis.com'];
    expect(actions(await evaluate('gcp.apis', fakes, rt))).toEqual([
      'enable: enable cloudresourcemanager.googleapis.com, firebasehosting.googleapis.com, iamcredentials.googleapis.com',
    ]);
  });

  it('skips when the services cannot be read', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.forbidden = ['serviceusage'];
    expect(await evaluate('gcp.apis', fakes, rt)).toMatchObject({
      kind: 'skipped',
      message: expect.stringContaining('insufficient permission'),
    });
  });
});

describe('gcp.pool', () => {
  it.each([
    [undefined, ['create: create workload identity pool github']],
    [{ state: 'DELETED' as const }, ['undelete: restore deleted workload identity pool github']],
    [{ state: 'ACTIVE' as const, disabled: true }, ['update: re-enable workload identity pool github']],
  ])('%j', async (pool, expected) => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    if (pool) fakes.google.state.pools[fakes.names.pool] = pool;
    else delete fakes.google.state.pools[fakes.names.pool];
    expect(actions(await evaluate('gcp.pool', fakes, rt))).toEqual(expected);
  });
});

describe('gcp.provider', () => {
  it('creates the provider without reading it when the pool is missing', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    delete fakes.google.state.pools[fakes.names.pool];
    expect(actions(await evaluate('gcp.provider', fakes, rt))).toEqual(['create: create provider github-987654321']);
    expect(fakes.google.calls.some((c) => c.url.includes('/providers/'))).toBe(false);
  });

  it('creates, restores, and re-enables the provider', async () => {
    const fakes = createConfiguredFakes();
    const provider = fakes.google.state.providers[fakes.names.provider]!;

    delete fakes.google.state.providers[fakes.names.provider];
    expect(actions(await evaluate('gcp.provider', fakes, await runtimeFor(fakes)))).toEqual([
      'create: create provider github-987654321',
    ]);

    fakes.google.state.providers[fakes.names.provider] = { ...provider, state: 'DELETED' };
    expect(actions(await evaluate('gcp.provider', fakes, await runtimeFor(fakes)))).toEqual([
      'undelete: restore deleted provider github-987654321',
    ]);

    fakes.google.state.providers[fakes.names.provider] = { ...provider, disabled: true, attributeMapping: {} };
    expect(actions(await evaluate('gcp.provider', fakes, await runtimeFor(fakes)))).toEqual([
      'update: re-enable provider github-987654321',
      'update: map google.subject, attribute.repository_id on provider github-987654321',
    ]);
  });

  it('blocks providers for other issuers', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.oidc = {};
    expect(await evaluate('gcp.provider', fakes, rt)).toMatchObject({
      kind: 'blocked',
      message: 'Provider github-987654321 uses issuer (none), not GitHub Actions.',
      error: { code: 'PROVIDER_OWNED_BY_OTHER_REPO' },
    });
  });
});

describe('gcp.provider-condition', () => {
  it.each([
    [undefined, ['update: limit provider github-987654321 to octo-org/site (no attribute condition)']],
    [
      "assertion.repository == 'octo-org/site'",
      ['update: pin provider github-987654321 to repository ID 987654321 instead of the name octo-org/site'],
    ],
    [
      "assertion.repository_owner_id == '1234567'",
      ["update: limit provider github-987654321 to octo-org/site (condition doesn't pin a repository ID)"],
    ],
    ["assertion.repository_id == '987654321'", 'ok'],
  ])('%s', async (condition, expected) => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = condition;
    expect(actions(await evaluate('gcp.provider-condition', fakes, rt))).toEqual(expected);
  });

  it('blocks providers that trust another repository', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.attributeCondition = "assertion.repository == 'other/repo'";
    expect(await evaluate('gcp.provider-condition', fakes, rt)).toMatchObject({
      kind: 'blocked',
      error: { code: 'PROVIDER_OWNED_BY_OTHER_REPO' },
      fix: expect.stringContaining('--provider'),
    });
  });

  it("skips providers that don't exist yet", async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.providers[fakes.names.provider]!.state = 'DELETED';
    expect(await evaluate('gcp.provider-condition', fakes, rt)).toEqual({
      kind: 'skipped',
      message: "provider github-987654321 doesn't exist yet",
    });
  });
});

describe('gcp.service-account', () => {
  it('creates and enables the service account', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.disabled = true;
    expect(actions(await evaluate('gcp.service-account', fakes, rt))).toEqual([
      `enable: enable service account ${fakes.names.serviceAccount}`,
    ]);

    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    expect(actions(await evaluate('gcp.service-account', fakes, await runtimeFor(fakes)))).toEqual([
      `create: create service account ${fakes.names.serviceAccount}`,
    ]);
  });
});

describe('gcp.project-roles', () => {
  it('grants each missing role separately', async () => {
    const fakes = createConfiguredFakes({ presets: ['hosting', 'firestore'] });
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.iamPolicy = {
      bindings: [{ role: 'roles/firebasehosting.admin', members: [`serviceAccount:${fakes.names.serviceAccount}`] }],
    };
    expect(actions(await evaluate('gcp.project-roles', fakes, rt))).toEqual(
      ['roles/datastore.indexAdmin', 'roles/firebaserules.admin', 'roles/serviceusage.serviceUsageConsumer'].map(
        (role) => `bind: grant ${role} on demo-project to ${fakes.names.serviceAccount}`,
      ),
    );
  });
});

describe('gcp.wi-user', () => {
  it("binds without reading the policy of a service account that doesn't exist", async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    expect(actions(await evaluate('gcp.wi-user', fakes, rt))).toEqual([
      `bind: let octo-org/site act as ${fakes.names.serviceAccount} (roles/iam.workloadIdentityUser)`,
    ]);
    expect(fakes.google.calls.some((c) => c.url.endsWith(':getIamPolicy'))).toBe(false);
  });

  it('only accepts the repository principal set', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy = {
      bindings: [
        { role: 'roles/iam.workloadIdentityUser', members: [fakes.names.principal.replace('987654321', '1')] },
      ],
    };
    expect((await evaluate('gcp.wi-user', fakes, rt)).kind).toBe('drift');
  });
});

describe('gcp.runtime-sa-user', () => {
  it('skips without the functions preset', async () => {
    expect(await evaluate('gcp.runtime-sa-user', createConfiguredFakes(), await runtimeFor())).toEqual({
      kind: 'skipped',
      message: 'no functions preset',
    });
  });

  it('binds each runtime service account', async () => {
    const fakes = createConfiguredFakes({ presets: ['functions'] });
    const runtime = '123456789012-compute@developer.gserviceaccount.com';
    const rt = await runtimeFor(fakes);
    fakes.google.state.serviceAccounts[runtime]!.iamPolicy = {};
    expect(actions(await evaluate('gcp.runtime-sa-user', fakes, rt))).toEqual([
      `bind: let ${fakes.names.serviceAccount} act as runtime ${runtime} (roles/iam.serviceAccountUser)`,
    ]);
  });
});

describe('gh.variables', () => {
  it('sets missing and stale variables', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    rt.variableValues.set('FIREBASE_WIF_PROVIDER', { kind: 'missing' });
    rt.variableValues.set('FIREBASE_WIF_SERVICE_ACCOUNT', {
      kind: 'found',
      value: 'old@demo-project.iam.gserviceaccount.com',
    });
    expect(actions(await evaluate('gh.variables', fakes, rt))).toEqual([
      `set: set repo variable FIREBASE_WIF_PROVIDER to ${fakes.names.provider}`,
      `set: set repo variable FIREBASE_WIF_SERVICE_ACCOUNT to ${fakes.names.serviceAccount}`,
    ]);
  });

  it('skips unreadable or disabled variables, and lists manual steps without GitHub', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    rt.variableValues.set('FIREBASE_WIF_PROVIDER', { kind: 'skipped', reason: 'insufficient permission (x)' });
    expect(await evaluate('gh.variables', fakes, rt)).toEqual({
      kind: 'skipped',
      message: 'insufficient permission (x)',
    });

    expect(await evaluate('gh.variables', fakes, { ...rt, ctx: { ...rt.ctx, variables: false } })).toEqual({
      kind: 'skipped',
      message: 'repo variables disabled',
    });

    const outcome = await evaluate('gh.variables', fakes, { ...rt, github: undefined });
    expect(outcome).toMatchObject({ kind: 'skipped', message: 'no GitHub credentials' });
    expect(outcome.kind === 'skipped' && outcome.changes?.every((c) => c.manual)).toBe(true);
  });
});

describe('gh.environment', () => {
  const env = (fakes: ConfiguredFakes) => fakes.github.state.repos['octo-org/site']!.environments!;

  it('creates a missing environment and branch policy', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    delete env(fakes).production;
    expect(actions(await evaluate('gh.environment', fakes, rt))).toEqual([
      'create: create environment production',
      'create: allow only main to deploy to production',
    ]);
  });

  it('limits the environment to the deploy branch', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    env(fakes).production = { deployment_branch_policy: null, branchPolicies: [] };
    expect(actions(await evaluate('gh.environment', fakes, rt))).toEqual([
      'update: limit production to selected branches',
      'create: allow main to deploy to production',
    ]);

    env(fakes).production = {
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      branchPolicies: ['main'],
    };
    expect(actions(await evaluate('gh.environment', fakes, rt))).toEqual([
      'update: limit production to selected branches',
    ]);
  });

  it('skips when disabled, unreadable, or without GitHub', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    expect(await evaluate('gh.environment', fakes, { ...rt, ctx: { ...rt.ctx, environment: false } })).toEqual({
      kind: 'skipped',
      message: 'environment disabled',
    });
    expect((await evaluate('gh.environment', fakes, { ...rt, github: undefined })).kind).toBe('skipped');
    fakes.github.state.forbidden = ['deployment-branch-policies'];
    expect(await evaluate('gh.environment', fakes, rt)).toMatchObject({
      kind: 'skipped',
      message: expect.stringContaining('insufficient permission'),
    });
  });
});
