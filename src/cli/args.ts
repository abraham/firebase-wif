import { parseArgs } from 'node:util';
import { DEFAULTS, type PresetName } from '../index.js';
import { isPresetName, PRESET_NAMES } from '../presets.js';

export const USAGE = `Usage: firebase-wif [status|setup] [options]

Commands:
  status                        Check the Firebase project and GitHub repo (default)
  setup                         Create or repair everything status checks

Options:
  --project <id|alias>          Firebase project ID or .firebaserc alias
  --all-aliases                 Run once per .firebaserc project, sharing the default project's trust chain
  --repo <owner/name>           GitHub repository
  --pool <id>                   Workload identity pool ID (default: github)
  --provider <id>               Provider ID (default: github-<repoId>)
  --service-account <id|email>  Deploy service account (default: github-<repoId>)
  --preset <name>               Role preset, repeatable: ${PRESET_NAMES.join(', ')} (default: from firebase.json)
  --role <role>                 Extra project role, repeatable
  --runtime-service-account <email>
                                Functions runtime service account, repeatable (default: the compute and App Engine defaults)
  --environment <name>          GitHub environment (default: ${DEFAULTS.environment})
  --no-environment              Skip the GitHub environment
  --branch <name>               Branch allowed to deploy (default: the repo's default branch)
  --any-branch                  Let any branch deploy to the environment
  --preview-environment <name>  GitHub environment any branch can deploy to, for preview channels
                                (default: the preview jobs' environment or ${DEFAULTS.previewEnvironment}, when a workflow deploys one)
  --no-preview-environment      Skip the preview environment
  --variable-prefix <prefix>    Repo variable prefix (default: ${DEFAULTS.variablePrefix})
  --detailed                    Show resource names, emails, role IDs, and check IDs
  --json                        Print JSON
  --cwd <dir>                   Directory to look for firebase.json and the git remote
  -h, --help                    Show this help
  --version                     Show the version

Setup options:
  --dry-run                     Print the plan without changing anything
  -y, --yes                     Apply without asking (required when stdin isn't a terminal)
  --adopt                       Adopt a setup found through legacy repo variables without asking
  --prune                       Remove unrequested roles from a service account firebase-wif manages
`;

const OPTIONS = {
  project: { type: 'string' },
  'all-aliases': { type: 'boolean' },
  repo: { type: 'string' },
  pool: { type: 'string' },
  provider: { type: 'string' },
  'service-account': { type: 'string' },
  preset: { type: 'string', multiple: true },
  role: { type: 'string', multiple: true },
  'runtime-service-account': { type: 'string', multiple: true },
  environment: { type: 'string' },
  'no-environment': { type: 'boolean' },
  'any-branch': { type: 'boolean' },
  branch: { type: 'string' },
  'preview-environment': { type: 'string' },
  'no-preview-environment': { type: 'boolean' },
  'variable-prefix': { type: 'string' },
  detailed: { type: 'boolean' },
  json: { type: 'boolean' },
  cwd: { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  adopt: { type: 'boolean' },
  prune: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

const SETUP_ONLY = ['dry-run', 'yes', 'adopt', 'prune'] as const;

/** Validated command-line arguments. */
export interface CliArgs {
  command: 'status' | 'setup';
  project: string | undefined;
  allAliases: boolean;
  repo: string | undefined;
  pool: string | undefined;
  provider: string | undefined;
  serviceAccount: string | undefined;
  presets: PresetName[];
  roles: string[] | undefined;
  runtimeServiceAccounts: string[] | undefined;
  environment: string | undefined;
  noEnvironment: boolean;
  branch: string | undefined;
  anyBranch: boolean;
  previewEnvironment: string | undefined;
  noPreviewEnvironment: boolean;
  variablePrefix: string;
  detailed: boolean;
  json: boolean;
  cwd: string | undefined;
  dryRun: boolean;
  yes: boolean;
  adopt: boolean;
  prune: boolean;
}

export type ParseResult =
  | { kind: 'help' }
  | { kind: 'version' }
  /** `message` is the full stderr text. */
  | { kind: 'usage-error'; message: string }
  | { kind: 'run'; args: CliArgs };

const usageError = (message: string): ParseResult => ({ kind: 'usage-error', message });

export const parseCli = (argv: readonly string[]): ParseResult => {
  // --help and --version win over every other error, so read them leniently first.
  const lenient = parseArgs({ args: [...argv], allowPositionals: true, strict: false, options: OPTIONS }).values;
  if (lenient.help) return { kind: 'help' };
  if (lenient.version) return { kind: 'version' };

  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (error) {
    return usageError(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  const command = positionals[0] ?? 'status';
  if ((command !== 'status' && command !== 'setup') || positionals.length > 1) {
    return usageError(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
  }
  const setupOnly = SETUP_ONLY.find((flag) => values[flag]);
  if (command === 'status' && setupOnly) return usageError(`--${setupOnly} only works with setup.\n`);
  if (values['any-branch'] && values.branch) return usageError('Pass either --branch or --any-branch, not both.\n');
  if (values['preview-environment'] && values['no-preview-environment']) {
    return usageError('Pass either --preview-environment or --no-preview-environment, not both.\n');
  }
  if (values['all-aliases'] && values.project) {
    return usageError('Pass either --project or --all-aliases, not both.\n');
  }
  const unknownPreset = values.preset?.find((name) => !isPresetName(name));
  if (unknownPreset !== undefined) {
    return usageError(`Unknown preset "${unknownPreset}". Use one of: ${PRESET_NAMES.join(', ')}.\n`);
  }

  return {
    kind: 'run',
    args: {
      command,
      project: values.project,
      allAliases: Boolean(values['all-aliases']),
      repo: values.repo,
      pool: values.pool,
      provider: values.provider,
      serviceAccount: values['service-account'],
      presets: (values.preset ?? []).filter(isPresetName),
      roles: values.role,
      runtimeServiceAccounts: values['runtime-service-account'],
      environment: values.environment,
      noEnvironment: Boolean(values['no-environment']),
      branch: values.branch,
      anyBranch: Boolean(values['any-branch']),
      previewEnvironment: values['preview-environment'],
      noPreviewEnvironment: Boolean(values['no-preview-environment']),
      variablePrefix: values['variable-prefix'] ?? DEFAULTS.variablePrefix,
      detailed: Boolean(values.detailed),
      json: Boolean(values.json),
      cwd: values.cwd,
      dryRun: Boolean(values['dry-run']),
      yes: Boolean(values.yes),
      adopt: Boolean(values.adopt),
      prune: Boolean(values.prune),
    },
  };
};
