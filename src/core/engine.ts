import { findAdoptCandidate } from './adopt.js';
import { createGitHubClient, toGitHubClient, toGoogleClient } from './clients.js';
import { GCP_ADVISORIES, GITHUB_ADVISORIES, LOCAL_CHECKS, type Advisory } from './checks.js';
import { FirebaseWifError, isAbortError, isFirebaseWifError, statusOf, WriteError } from './errors.js';
import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_POOL,
  DEFAULT_VARIABLE_PREFIX,
  defaultComputeServiceAccount,
  defaultProviderId,
  defaultServiceAccountId,
  parseProviderName,
  poolName,
  providerName,
  serviceAccountEmail,
  serviceAccountProject,
  validatePoolOrProvider,
  validateProjectId,
  validateRepo,
  validateRole,
  validateServiceAccountEmail,
  validateVariableName,
} from './naming.js';
import { RESOURCES, type Outcome, type Resource } from './resources.js';
import { createMemo, CRM, isCrossProject, read, type Read, type RepoResource, type Runtime } from './runtime.js';
import type {
  AdoptCandidate,
  ApplyResult,
  Change,
  Check,
  Context,
  GitHubClient,
  GoogleClient,
  Options,
  Plan,
  Preflight,
  ResourceId,
  SetupOptions,
  SetupResult,
  StatusReport,
} from './types.js';
import { defaultSleep, type Writer } from './writes.js';
import { apisFor, PRESET_NAMES, resolvePresets, rolesFor } from '../presets.js';

/** Everything `setup` calls, so a preflight can say exactly what the operator lacks. */
export const SETUP_PERMISSIONS: readonly string[] = [
  'iam.serviceAccounts.create',
  'iam.serviceAccounts.setIamPolicy',
  'iam.workloadIdentityPools.create',
  'iam.workloadIdentityPools.undelete',
  'iam.workloadIdentityPoolProviders.create',
  'iam.workloadIdentityPoolProviders.update',
  'iam.workloadIdentityPoolProviders.undelete',
  'resourcemanager.projects.setIamPolicy',
  'serviceusage.services.enable',
];

/** What `setup` calls in a project that reuses another project's trust chain (docs/multi-project.md). */
export const CROSS_PROJECT_PERMISSIONS: readonly string[] = [
  'iam.serviceAccounts.setIamPolicy',
  'resourcemanager.projects.setIamPolicy',
  'serviceusage.services.enable',
];

// Only the home project exchanges tokens.
const TOKEN_EXCHANGE_APIS = ['iamcredentials.googleapis.com', 'sts.googleapis.com'];

const withSignal = <C extends GoogleClient | GitHubClient>(client: C, signal: AbortSignal | undefined): C =>
  signal
    ? ({
        request: (method: string, url: string, body?: unknown) => {
          signal.throwIfAborted();
          return client.request(method, url, body);
        },
      } as C)
    : client;

const rethrowAbort = (error: unknown) => {
  if (isAbortError(error)) throw error;
};

const fetchRepo = async (client: GitHubClient, repo: string, authenticated: boolean): Promise<RepoResource> => {
  try {
    return await client.request<RepoResource>('GET', `/repos/${repo}`);
  } catch (error) {
    rethrowAbort(error);
    const status = statusOf(error);
    throw new FirebaseWifError(
      'REPO_NOT_FOUND',
      `Could not read GitHub repository ${repo}${status ? ` (${status})` : ''}.`,
      {
        fix: authenticated
          ? 'Check the repository name and your GitHub access.'
          : 'Private repositories need GitHub credentials: gh auth login.',
      },
    );
  }
};

const fetchProjectNumber = async (google: GoogleClient, projectId: string): Promise<string> => {
  try {
    const { projectNumber } = await google.request<{ projectNumber?: string }>('GET', `${CRM}/projects/${projectId}`);
    if (!projectNumber) throw new Error('missing projectNumber');
    return projectNumber;
  } catch (error) {
    rethrowAbort(error);
    const status = statusOf(error);
    throw new FirebaseWifError(
      'PROJECT_NOT_FOUND',
      `Could not read Google Cloud project ${projectId}${status ? ` (${status})` : ''}.`,
      {
        fix: 'Check the project ID and that your account can view it.',
      },
    );
  }
};

const readVariables = async (
  github: GitHubClient | undefined,
  repo: string,
  names: Context['variables'],
): Promise<Map<string, Read<string>>> => {
  const values = new Map<string, Read<string>>();
  if (!github || !names) return values;
  for (const name of [names.provider, names.serviceAccount]) {
    const result = await read(() =>
      github.request<{ value: string }>('GET', `/repos/${repo}/actions/variables/${name}`),
    );
    values.set(name, result.kind === 'found' ? { kind: 'found', value: result.value.value } : result);
  }
  return values;
};

const runPreflight = async (
  google: GoogleClient,
  ctx: Context,
  repo: RepoResource,
  github: boolean,
): Promise<Preflight> => {
  const needed = isCrossProject(ctx) ? CROSS_PROJECT_PERMISSIONS : SETUP_PERMISSIONS;
  let granted: string[] = [];
  try {
    ({ permissions: granted = [] } = await google.request<{ permissions?: string[] }>(
      'POST',
      `${CRM}/projects/${ctx.projectId}:testIamPermissions`,
      { permissions: needed },
    ));
  } catch (error) {
    rethrowAbort(error);
  }
  return {
    missingPermissions: needed.filter((permission) => !granted.includes(permission)),
    githubAdmin: github ? Boolean(repo.permissions?.admin) : undefined,
  };
};

/** The provider and SA to use: `home`, else the repo variables, else an adopted legacy setup. */
const linkedChain = (
  options: Options,
  variables: Context['variables'],
  values: Map<string, Read<string>>,
  adopted: AdoptCandidate | undefined,
): { provider?: string | undefined; serviceAccount?: string | undefined } => {
  if (options.home) {
    if (!parseProviderName(options.home.provider)) {
      throw new FirebaseWifError(
        'INVALID_NAME',
        `Invalid provider "${options.home.provider}": expected a full provider resource name.`,
      );
    }
    return {
      provider: options.home.provider,
      serviceAccount: validateServiceAccountEmail(options.home.serviceAccount),
    };
  }
  const found = (name: string | undefined) => {
    const value = name ? values.get(name) : undefined;
    return value?.kind === 'found' ? value.value : undefined;
  };
  return {
    provider: found(variables ? variables.provider : undefined) ?? adopted?.provider,
    serviceAccount: found(variables ? variables.serviceAccount : undefined) ?? adopted?.serviceAccount,
  };
};

const buildContext = (
  options: Options,
  repo: RepoResource,
  projectNumber: string,
  variables: Context['variables'],
  values: Map<string, Read<string>>,
  adopted: AdoptCandidate | undefined,
): Context => {
  const { projectId } = options;
  const linked = linkedChain(options, variables, values, adopted);
  const fromVariable = parseProviderName(linked.provider ?? '');
  const named = Object.values(options.names ?? {}).some(Boolean);

  // A chain in another project is reused as is; explicit names start an independent chain instead.
  const home =
    !named && fromVariable && fromVariable.projectNumber !== projectNumber && linked.serviceAccount
      ? { ...fromVariable, serviceAccount: linked.serviceAccount }
      : undefined;
  const sameProject = fromVariable?.projectNumber === projectNumber ? fromVariable : undefined;

  const pool = validatePoolOrProvider('pool', home?.pool ?? options.names?.pool ?? sameProject?.pool ?? DEFAULT_POOL);
  const provider = validatePoolOrProvider(
    'provider',
    home?.provider ?? options.names?.provider ?? sameProject?.provider ?? defaultProviderId(repo.id),
  );
  const serviceAccount = home
    ? home.serviceAccount
    : options.names?.serviceAccount
      ? serviceAccountEmail(options.names.serviceAccount, projectId)
      : linked.serviceAccount && serviceAccountProject(linked.serviceAccount) === projectId
        ? linked.serviceAccount
        : serviceAccountEmail(defaultServiceAccountId(repo.id), projectId);
  const chainProjectNumber = home?.projectNumber ?? projectNumber;

  const presets =
    options.presets === undefined || options.presets === 'auto'
      ? resolvePresets(options.firebaseJson ?? options.local?.firebaseJson)
      : options.presets.map((name) => {
          if (!PRESET_NAMES.includes(name)) throw new FirebaseWifError('INVALID_NAME', `Unknown preset "${name}".`);
          return name;
        });

  const runtimeServiceAccounts = presets.includes('functions')
    ? (options.runtimeServiceAccounts ?? [defaultComputeServiceAccount(projectNumber)]).map(validateServiceAccountEmail)
    : [];

  return {
    projectId,
    projectNumber,
    repo: options.repo,
    repoId: repo.id,
    ownerId: repo.owner.id,
    defaultBranch: repo.default_branch,
    pool: poolName(chainProjectNumber, pool),
    provider: providerName(chainProjectNumber, pool, provider),
    serviceAccount,
    homeProjectId: home ? (serviceAccountProject(home.serviceAccount) ?? home.projectNumber) : projectId,
    variables,
    environment:
      options.environment === false
        ? false
        : {
            name: options.environment?.name ?? DEFAULT_ENVIRONMENT,
            branch: options.environment?.branch ?? repo.default_branch,
          },
    presets,
    roles: rolesFor({ presets, roles: (options.roles ?? []).map(validateRole) }),
    apis: home ? apisFor(presets).filter((api) => !TOKEN_EXCHANGE_APIS.includes(api)) : apisFor(presets),
    runtimeServiceAccounts,
    ...(adopted ? { adopted } : {}),
  };
};

/** Offers a legacy setup for adoption when this repo has none of the expected variables yet. */
const considerAdoption = async (
  options: Options,
  github: GitHubClient | undefined,
  variables: Context['variables'],
  values: Map<string, Read<string>>,
  project: { projectId: string; projectNumber: string },
): Promise<AdoptCandidate | undefined> => {
  if (!options.adopt || options.home || !github || !variables) return undefined;
  if ([variables.provider, variables.serviceAccount].some((name) => values.get(name)?.kind !== 'missing'))
    return undefined;
  const listed = await read(() =>
    github.request<{ variables?: { name: string; value: string }[] }>(
      'GET',
      `/repos/${options.repo}/actions/variables?per_page=30`,
    ),
  );
  if (listed.kind !== 'found') return undefined;
  const candidate = findAdoptCandidate(listed.value.variables ?? [], project);
  if (!candidate) return undefined;
  const accepted = typeof options.adopt === 'function' ? await options.adopt(candidate) : true;
  return accepted ? candidate : undefined;
};

type Entry = { resource: Resource } | { advisory: Advisory };

/** In a project that reuses another project's chain, only project-scoped resources are reconciled. */
const evaluate = (resource: Resource, rt: Runtime): Promise<Outcome> =>
  resource.scope === 'trust-chain' && isCrossProject(rt.ctx)
    ? Promise.resolve({
        kind: 'skipped',
        message: `shared from ${rt.ctx.homeProjectId}; check it with --project ${rt.ctx.homeProjectId}`,
      })
    : resource.evaluate(rt);

const entries = (ctx: Context): Entry[] => {
  const resource = (id: ResourceId): Entry => ({ resource: RESOURCES.find((r) => r.id === id)! });
  const advisory = (value: Advisory): Entry => ({ advisory: value });
  return [
    ...LOCAL_CHECKS.map(advisory),
    advisory(GCP_ADVISORIES.project),
    advisory(GCP_ADVISORIES.operator),
    resource('gcp.apis'),
    resource('gcp.pool'),
    resource('gcp.provider'),
    resource('gcp.provider-condition'),
    resource('gcp.service-account'),
    advisory(GCP_ADVISORIES.serviceAccountKeys),
    resource('gcp.project-roles'),
    advisory(GCP_ADVISORIES.extraRoles),
    resource('gcp.wi-user'),
    advisory(GCP_ADVISORIES.broadImpersonation),
    ...(ctx.runtimeServiceAccounts.length ? [resource('gcp.runtime-sa-user')] : []),
    advisory(GITHUB_ADVISORIES.repo),
    resource('gh.variables'),
    resource('gh.environment'),
    advisory(GITHUB_ADVISORIES.legacySecrets),
    advisory(GITHUB_ADVISORIES.oidcSub),
    advisory(GITHUB_ADVISORIES.workflows),
  ];
};

const toCheck = (resource: Resource, outcome: Outcome): Check => {
  switch (outcome.kind) {
    case 'ok':
      return { id: resource.id, status: 'pass', message: outcome.message };
    case 'drift':
      return {
        id: resource.id,
        status: resource.severity,
        message: outcome.message,
        fix: outcome.fix ?? 'firebase-wif setup',
      };
    case 'skipped':
      return {
        id: resource.id,
        status: 'skipped',
        message: outcome.message,
        ...(outcome.changes?.length ? { fix: outcome.changes.map((c) => c.description).join('; ') } : {}),
      };
    case 'blocked':
      return { id: resource.id, status: 'fail', message: outcome.message, fix: outcome.fix };
  }
};

interface Inspection {
  report: StatusReport;
  blocked: FirebaseWifError[];
  runtime: Runtime;
}

const inspect = async (options: Options): Promise<Inspection> => {
  validateProjectId(options.projectId);
  validateRepo(options.repo);
  const variables: Context['variables'] =
    options.variables === false
      ? false
      : {
          provider: validateVariableName(options.variables?.provider ?? `${DEFAULT_VARIABLE_PREFIX}PROVIDER`),
          serviceAccount: validateVariableName(
            options.variables?.serviceAccount ?? `${DEFAULT_VARIABLE_PREFIX}SERVICE_ACCOUNT`,
          ),
        };

  const { signal } = options;
  const google = withSignal(await toGoogleClient(options.google), signal);
  const github = options.github === false ? undefined : withSignal(await toGitHubClient(options.github), signal);

  const repo = await fetchRepo(github ?? withSignal(createGitHubClient(), signal), options.repo, Boolean(github));
  const projectNumber = await fetchProjectNumber(google, options.projectId);
  const values = await readVariables(github, options.repo, variables);
  const adopted = await considerAdoption(options, github, variables, values, {
    projectId: options.projectId,
    projectNumber,
  });
  const ctx = buildContext(options, repo, projectNumber, variables, values, adopted);
  const preflight = await runPreflight(google, ctx, repo, Boolean(github));

  const rt: Runtime = {
    ctx,
    google,
    github,
    local: options.local,
    repo,
    preflight,
    variableValues: values,
    prune: Boolean(options.prune),
    memo: createMemo(),
  };

  const blocked: FirebaseWifError[] = [];
  const changesByResource = new Map<string, Change[]>();
  const emit = (check: Check) => {
    options.onEvent?.({ type: 'check', check });
    return check;
  };

  const checks = await Promise.all(
    entries(ctx).map(async (entry): Promise<Check> => {
      if ('advisory' in entry) return emit({ id: entry.advisory.id, ...(await entry.advisory.run(rt)) });
      const outcome = await evaluate(entry.resource, rt);
      if (outcome.kind === 'blocked') blocked.push(outcome.error);
      if (outcome.kind === 'drift' || outcome.kind === 'skipped') {
        changesByResource.set(entry.resource.id, outcome.kind === 'drift' ? outcome.changes : (outcome.changes ?? []));
      }
      return emit(toCheck(entry.resource, outcome));
    }),
  );

  const changes = RESOURCES.flatMap((resource) => changesByResource.get(resource.id) ?? []);
  return {
    report: { ok: !checks.some((check) => check.status === 'fail'), context: ctx, checks, changes, preflight },
    blocked,
    runtime: rt,
  };
};

/** Read-only: every reconcile resource's diff plus the advisory checks. */
export const status = async (options: Options): Promise<StatusReport> => (await inspect(options)).report;

/** Throws `MISSING_PERMISSIONS` when the plan writes to Google Cloud and the preflight found gaps. */
export const assertCanApply = (changes: Change[], preflight: Preflight) => {
  const { missingPermissions } = preflight;
  if (!missingPermissions.length || !changes.some((c) => !c.manual && c.resource.startsWith('gcp.'))) return;
  throw new FirebaseWifError(
    'MISSING_PERMISSIONS',
    `You're missing permissions that setup needs: ${missingPermissions.join(', ')}.`,
    {
      fix: 'Ask a project owner to run firebase-wif setup.',
      details: { missingPermissions },
    },
  );
};

const applyError = (error: unknown, failed: Change, applied: Change[]): unknown => {
  if (isAbortError(error)) return error;
  const done = applied.length ? ` Already applied: ${applied.map((c) => c.description).join('; ')}.` : '';
  const details = { failed, applied: [...applied] };
  if (error instanceof WriteError || isFirebaseWifError(error, 'PROVIDER_OWNED_BY_OTHER_REPO'))
    return new FirebaseWifError(error.code, `${error.message}${done}`, { fix: error.fix, details });
  if (error instanceof FirebaseWifError) return error;
  const status = statusOf(error);
  const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
  return new FirebaseWifError(
    'APPLY_FAILED',
    `Couldn't ${failed.description}${status ? ` (${status})` : ''}: ${reason}.${done}`,
    {
      fix: 'Fix the cause, then re-run firebase-wif setup; every step is safe to repeat.',
      details,
    },
  );
};

/** Re-reads and applies each resource in order, then re-runs status. */
const applyChanges = async (
  options: Options,
  inspection: Inspection,
  signal: AbortSignal | undefined,
): Promise<ApplyResult> => {
  const { runtime: base, report } = inspection;
  assertCanApply(report.changes, report.preflight);
  const google = withSignal(base.google, signal);
  const github = base.github && withSignal(base.github, signal);
  const w: Writer = {
    sleep: options.sleep ?? defaultSleep,
    emit: (event) => options.onEvent?.(event),
    signal,
    createdServiceAccount: false,
  };

  const applied: Change[] = [];
  const manual: Change[] = [];
  for (const resource of RESOURCES) {
    let pending: Change[] = [];
    // A second pass covers follow-up changes, like patching a provider right after restoring it.
    for (let pass = 0; pass < 2; pass++) {
      signal?.throwIfAborted();
      const rt: Runtime = {
        ...base,
        google,
        github,
        memo: createMemo(),
        variableValues:
          resource.id === 'gh.variables'
            ? await readVariables(github, base.ctx.repo, base.ctx.variables)
            : base.variableValues,
      };
      const outcome = await evaluate(resource, rt);
      if (outcome.kind === 'blocked')
        throw applyError(
          outcome.error,
          { resource: resource.id, action: 'update', description: outcome.message },
          applied,
        );
      const changes =
        outcome.kind === 'drift' ? outcome.changes : outcome.kind === 'skipped' ? (outcome.changes ?? []) : [];
      pending = changes.filter((c) => c.manual);
      const automatic = changes.filter((c) => !c.manual);
      if (!automatic.length) break;

      for (const change of automatic) w.emit({ type: 'change:start', change });
      try {
        await resource.apply(rt, w);
      } catch (error) {
        throw applyError(error, automatic[0]!, applied);
      }
      for (const change of automatic) {
        applied.push(change);
        w.emit({ type: 'change:done', change });
      }
    }
    manual.push(...pending);
  }

  const { report: after } = await inspect({
    ...options,
    google: base.google,
    github: base.github ?? false,
    adopt: Boolean(base.ctx.adopted),
    signal,
  });
  return { applied, manual, status: after };
};

/** Read-only: the ordered changes `setup` would make. */
export const plan = async (options: Options): Promise<Plan> => {
  const inspection = await inspect(options);
  if (inspection.blocked[0]) throw inspection.blocked[0];
  const { report } = inspection;
  return {
    context: report.context,
    changes: report.changes,
    preflight: report.preflight,
    apply: (applyOptions) => applyChanges(options, inspection, applyOptions?.signal ?? options.signal),
  };
};

/** Plans, asks `confirm`, then applies. Throws `MISSING_PERMISSIONS` before writing anything. */
export const setup = async ({ confirm, ...options }: SetupOptions): Promise<SetupResult> => {
  const planned = await plan(options);
  assertCanApply(planned.changes, planned.preflight);
  if (confirm && !(await confirm(planned))) return { cancelled: true, plan: planned };
  return { ...(await planned.apply()), cancelled: false };
};
