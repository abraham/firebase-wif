import { DEFAULTS, type GitHubClient, type GoogleClient, type Options, type ResolvedContext } from '../index.js';
import type { CliArgs } from './args.js';

/** The engine options for one project, from the arguments and what was discovered for it. */
export const buildOptions = ({
  args,
  resolved,
  google,
  github,
  signal,
  home,
}: {
  args: CliArgs;
  resolved: Pick<ResolvedContext, 'projectId' | 'repo' | 'local'>;
  google: GoogleClient;
  github: GitHubClient | false;
  signal?: AbortSignal | undefined;
  home?: Options['home'];
}): Options => ({
  projectId: resolved.projectId,
  repo: resolved.repo,
  google,
  github,
  presets: args.presets.length ? args.presets : 'auto',
  roles: args.roles,
  runtimeServiceAccounts: args.runtimeServiceAccounts,
  names: { pool: args.pool, provider: args.provider, serviceAccount: args.serviceAccount },
  variables: { provider: `${args.variablePrefix}PROVIDER`, serviceAccount: `${args.variablePrefix}SERVICE_ACCOUNT` },
  environment: args.noEnvironment
    ? false
    : { name: args.environment ?? DEFAULTS.environment, branch: args.anyBranch ? false : args.branch },
  previewEnvironment: args.noPreviewEnvironment
    ? false
    : args.previewEnvironment
      ? { name: args.previewEnvironment }
      : undefined,
  local: resolved.local,
  signal,
  ...(home ? { home } : {}),
});
