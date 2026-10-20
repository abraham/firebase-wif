import { read, type Read } from '../io/reads.js';
import { parseProviderName, serviceAccountProject } from '../naming.js';
import type { AdoptCandidate, Context, GitHubClient, Options } from '../types.js';

/** Variable pairs written by `setup-wif.sh` and by hoverboard's `setup-github`. */
export const LEGACY_VARIABLES: readonly (readonly [provider: string, serviceAccount: string])[] = [
  ['GCP_WIF_PROVIDER', 'GCP_DEPLOY_SA'],
  ['WIF_PROVIDER', 'DEPLOY_SERVICE_ACCOUNT'],
];

/**
 * Finds an existing setup to adopt from repo variables: a known legacy pair first, then any variables
 * whose values look like a provider in this project and a service account email.
 */
export const findAdoptCandidate = (
  variables: { name: string; value: string }[],
  project: { projectId: string; projectNumber: string },
): AdoptCandidate | undefined => {
  const values = new Map(variables.map(({ name, value }) => [name, value.trim()]));
  const isProvider = (value: string | undefined) =>
    parseProviderName(value ?? '')?.projectNumber === project.projectNumber;
  const isAccount = (value: string | undefined) => serviceAccountProject(value ?? '') === project.projectId;

  const pairs = [
    ...LEGACY_VARIABLES,
    [
      variables.find(({ value }) => isProvider(value.trim()))?.name ?? '',
      variables.find(({ value }) => isAccount(value.trim()))?.name ?? '',
    ] as const,
  ];
  for (const [provider, serviceAccount] of pairs) {
    if (isProvider(values.get(provider)) && isAccount(values.get(serviceAccount))) {
      return {
        provider: values.get(provider)!,
        serviceAccount: values.get(serviceAccount)!,
        variables: { provider, serviceAccount },
      };
    }
  }
  return undefined;
};

/** Offers a legacy setup for adoption when this repo has none of the expected variables yet. */
export const considerAdoption = async (
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
