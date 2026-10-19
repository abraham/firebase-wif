import { createGitHubClient, toGitHubClient, toGoogleClient } from './clients.js';
import { GCP_ADVISORIES, GITHUB_ADVISORIES, LOCAL_CHECKS, type Advisory } from './checks.js';
import { FirebaseWifError, statusOf } from './errors.js';
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
import { createMemo, CRM, read, type Read, type RepoResource, type Runtime } from './runtime.js';
import type {
  Change,
  Check,
  Context,
  GitHubClient,
  GoogleClient,
  Options,
  Plan,
  Preflight,
  StatusReport,
} from './types.js';
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
  if ((error as Error | undefined)?.name === 'AbortError') throw error;
};

const fetchRepo = async (client: GitHubClient, repo: string, authenticated: boolean): Promise<RepoResource> => {
  try {
    return await client.request<RepoResource>('GET', `/repos/${repo}`);
  } catch (error) {
    rethrowAbort(error);
    const status = statusOf(error);
    throw new FirebaseWifError('REPO_NOT_FOUND', `Could not read GitHub repository ${repo}${status ? ` (${status})` : ''}.`, {
      fix: authenticated ? 'Check the repository name and your GitHub access.' : 'Private repositories need GitHub credentials: gh auth login.',
    });
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
    throw new FirebaseWifError('PROJECT_NOT_FOUND', `Could not read Google Cloud project ${projectId}${status ? ` (${status})` : ''}.`, {
      fix: 'Check the project ID and that your account can view it.',
    });
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
    const result = await read(() => github.request<{ value: string }>('GET', `/repos/${repo}/actions/variables/${name}`));
    values.set(name, result.kind === 'found' ? { kind: 'found', value: result.value.value } : result);
  }
  return values;
};

const runPreflight = async (google: GoogleClient, projectId: string, repo: RepoResource, github: boolean): Promise<Preflight> => {
  let granted: string[] = [];
  try {
    ({ permissions: granted = [] } = await google.request<{ permissions?: string[] }>(
      'POST',
      `${CRM}/projects/${projectId}:testIamPermissions`,
      { permissions: SETUP_PERMISSIONS },
    ));
  } catch (error) {
    rethrowAbort(error);
  }
  return {
    missingPermissions: SETUP_PERMISSIONS.filter((permission) => !granted.includes(permission)),
    githubAdmin: github ? Boolean(repo.permissions?.admin) : undefined,
  };
};

const buildContext = (
  options: Options,
  repo: RepoResource,
  projectNumber: string,
  variables: Context['variables'],
  values: Map<string, Read<string>>,
): Context => {
  const { projectId } = options;
  const found = (name: string | undefined) => {
    const value = name ? values.get(name) : undefined;
    return value?.kind === 'found' ? value.value : undefined;
  };

  // Existing repo variables point at the resources to check, unless flags override them.
  const fromVariable = parseProviderName(found(variables ? variables.provider : undefined) ?? '');
  const sameProject = fromVariable?.projectNumber === projectNumber ? fromVariable : undefined;
  const variableAccount = found(variables ? variables.serviceAccount : undefined);

  const pool = validatePoolOrProvider('pool', options.names?.pool ?? sameProject?.pool ?? DEFAULT_POOL);
  const provider = validatePoolOrProvider('provider', options.names?.provider ?? sameProject?.provider ?? defaultProviderId(repo.id));
  const serviceAccount = options.names?.serviceAccount
    ? serviceAccountEmail(options.names.serviceAccount, projectId)
    : variableAccount && serviceAccountProject(variableAccount) === projectId
      ? variableAccount
      : serviceAccountEmail(defaultServiceAccountId(repo.id), projectId);

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
    pool: poolName(projectNumber, pool),
    provider: providerName(projectNumber, pool, provider),
    serviceAccount,
    homeProjectId: projectId,
    variables,
    environment:
      options.environment === false
        ? false
        : {
            name: options.environment?.name ?? DEFAULT_ENVIRONMENT,
            branch: options.environment?.branch ?? repo.default_branch,
          },
    presets,
    roles: rolesFor({ presets, roles: (options.roles ?? []).map(validateRole), scheduler: options.scheduler }),
    apis: apisFor(presets),
    runtimeServiceAccounts,
  };
};

type Entry = { resource: Resource } | { advisory: Advisory };

const entries = (ctx: Context): Entry[] => {
  const resource = (id: string): Entry => ({ resource: RESOURCES.find((r) => r.id === id)! });
  const advisory = (value: Advisory): Entry => ({ advisory: value });
  return [
    ...LOCAL_CHECKS.map(advisory),
    advisory(GCP_ADVISORIES.project!),
    advisory(GCP_ADVISORIES.operator!),
    resource('gcp.apis'),
    resource('gcp.pool'),
    resource('gcp.provider'),
    resource('gcp.provider-condition'),
    resource('gcp.service-account'),
    advisory(GCP_ADVISORIES.serviceAccountKeys!),
    resource('gcp.project-roles'),
    advisory(GCP_ADVISORIES.extraRoles!),
    resource('gcp.wi-user'),
    advisory(GCP_ADVISORIES.broadImpersonation!),
    ...(ctx.runtimeServiceAccounts.length ? [resource('gcp.runtime-sa-user')] : []),
    advisory(GITHUB_ADVISORIES[0]!),
    resource('gh.variables'),
    resource('gh.environment'),
    ...GITHUB_ADVISORIES.slice(1).map(advisory),
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
}

const inspect = async (options: Options): Promise<Inspection> => {
  validateProjectId(options.projectId);
  validateRepo(options.repo);
  const variables: Context['variables'] =
    options.variables === false
      ? false
      : {
          provider: validateVariableName(options.variables?.provider ?? `${DEFAULT_VARIABLE_PREFIX}PROVIDER`),
          serviceAccount: validateVariableName(options.variables?.serviceAccount ?? `${DEFAULT_VARIABLE_PREFIX}SERVICE_ACCOUNT`),
        };

  const { signal } = options;
  const google = withSignal(await toGoogleClient(options.google), signal);
  const github = options.github === false ? undefined : withSignal(await toGitHubClient(options.github), signal);

  const repo = await fetchRepo(github ?? withSignal(createGitHubClient(), signal), options.repo, Boolean(github));
  const projectNumber = await fetchProjectNumber(google, options.projectId);
  const values = await readVariables(github, options.repo, variables);
  const ctx = buildContext(options, repo, projectNumber, variables, values);
  const preflight = await runPreflight(google, options.projectId, repo, Boolean(github));

  const rt: Runtime = {
    ctx,
    google,
    github,
    local: options.local,
    repo,
    preflight,
    variableValues: values,
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
      const outcome = await entry.resource.evaluate(rt);
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
  };
};

/** Read-only: every reconcile resource's diff plus the advisory checks. */
export const status = async (options: Options): Promise<StatusReport> => (await inspect(options)).report;

/** Read-only: the ordered changes `setup` would make. */
export const plan = async (options: Options): Promise<Plan> => {
  const { report, blocked } = await inspect(options);
  if (blocked[0]) throw blocked[0];
  return {
    context: report.context,
    changes: report.changes,
    preflight: report.preflight,
    apply: async () => {
      throw new FirebaseWifError('NOT_IMPLEMENTED', 'Applying a plan arrives with firebase-wif setup in a later release.');
    },
  };
};
