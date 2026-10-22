import { apisFor, PRESET_NAMES, resolvePresets, rolesFor } from '../../presets.js';
import { analyzeWorkflows } from '../checks/workflows.js';
import { FirebaseWifError } from '../errors.js';
import type { Read, RepoResource } from '../io/reads.js';
import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_POOL,
  DEFAULT_PREVIEW_ENVIRONMENT,
  defaultAppEngineServiceAccount,
  defaultComputeServiceAccount,
  defaultProviderId,
  defaultServiceAccountId,
  parseProviderName,
  poolName,
  providerName,
  serviceAccountEmail,
  serviceAccountProject,
  validatePoolOrProvider,
  validateRole,
  validateServiceAccountEmail,
} from '../naming.js';
import type { AdoptCandidate, Context, Options } from '../types.js';

// Only the home project exchanges tokens.
const TOKEN_EXCHANGE_APIS = ['iamcredentials.googleapis.com', 'sts.googleapis.com'];

/** Deploy roles for another project, using the trust chain set up in the home project (docs/multi-project.md). */
export const isCrossProject = (ctx: Context): boolean => ctx.homeProjectId !== ctx.projectId;

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

/** The given preview environment, else one for the local workflows' preview channel deploys. */
const previewEnvironment = (options: Options, production: Context['environment']): Context['previewEnvironment'] => {
  if (options.previewEnvironment === false) return false;
  if (options.previewEnvironment) {
    const { name } = options.previewEnvironment;
    if (production && production.name === name) {
      throw new FirebaseWifError(
        'INVALID_NAME',
        `Invalid preview environment "${name}": it must differ from the deploy environment.`,
      );
    }
    return { name };
  }
  const analysis = analyzeWorkflows(options.local?.workflows ?? {});
  if (!analysis.previewJobs) return false;
  const named = analysis.previewEnvironments.find((name) => !production || name !== production.name);
  if (named) return { name: named };
  // Preview jobs can already use a deploy environment that any branch can deploy to.
  return production && production.branch === false ? false : { name: DEFAULT_PREVIEW_ENVIRONMENT };
};

/** Works out every name in the trust chain, and whether another project holds it. */
export const buildContext = (
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
    ? (
        options.runtimeServiceAccounts ?? [
          defaultComputeServiceAccount(projectNumber),
          // firebase-tools requires actAs on it before any functions deploy, when it exists.
          defaultAppEngineServiceAccount(projectId),
        ]
      ).map(validateServiceAccountEmail)
    : [];

  const environment: Context['environment'] =
    options.environment === false
      ? false
      : {
          name: options.environment?.name ?? DEFAULT_ENVIRONMENT,
          branch: options.environment?.branch ?? repo.default_branch,
        };

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
    environment,
    previewEnvironment: previewEnvironment(options, environment),
    presets,
    roles: rolesFor({ presets, roles: (options.roles ?? []).map(validateRole) }),
    apis: home ? apisFor(presets).filter((api) => !TOKEN_EXCHANGE_APIS.includes(api)) : apisFor(presets),
    runtimeServiceAccounts,
    ...(adopted ? { adopted } : {}),
  };
};
