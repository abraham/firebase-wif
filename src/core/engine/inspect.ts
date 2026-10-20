import { createGitHubClient, toGitHubClient, toGoogleClient } from '../discovery/clients.js';
import { FirebaseWifError, isAbortError, statusOf } from '../errors.js';
import { CRM } from '../io/endpoints.js';
import { createMemo, read, type Read, type RepoResource, type Runtime } from '../io/reads.js';
import { DEFAULT_VARIABLE_PREFIX, validateProjectId, validateRepo, validateVariableName } from '../naming.js';
import { RESOURCES } from '../resources/registry.js';
import type { Outcome, Resource } from '../resources/resource.js';
import type { Change, Check, Context, GitHubClient, GoogleClient, Options, StatusReport } from '../types.js';
import { considerAdoption } from './adopt.js';
import { entries } from './catalog.js';
import { buildContext, isCrossProject } from './chain.js';
import { runPreflight } from './permissions.js';

/** Wraps a client so it stops at the next request once `signal` fires. */
export const withSignal = <C extends GoogleClient | GitHubClient>(client: C, signal: AbortSignal | undefined): C =>
  signal
    ? ({
        request: (method: string, url: string, body?: unknown) => {
          signal.throwIfAborted();
          return client.request(method, url, body);
        },
      } as C)
    : client;

const fetchRepo = async (client: GitHubClient, repo: string, authenticated: boolean): Promise<RepoResource> => {
  try {
    return await client.request<RepoResource>('GET', `/repos/${repo}`);
  } catch (error) {
    if (isAbortError(error)) throw error;
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
    if (isAbortError(error)) throw error;
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

export const readVariables = async (
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

/** In a project that reuses another project's chain, only project-scoped resources are reconciled. */
export const evaluate = (resource: Resource, rt: Runtime): Promise<Outcome> =>
  resource.scope === 'trust-chain' && isCrossProject(rt.ctx)
    ? Promise.resolve({
        kind: 'skipped',
        message: `shared from ${rt.ctx.homeProjectId}; check it with --project ${rt.ctx.homeProjectId}`,
      })
    : resource.evaluate(rt);

export const toCheck = (resource: Resource, outcome: Outcome): Check => {
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

export interface Inspection {
  report: StatusReport;
  blocked: FirebaseWifError[];
  runtime: Runtime;
}

/** Reads everything once and evaluates every check, without writing. */
export const inspect = async (options: Options): Promise<Inspection> => {
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
