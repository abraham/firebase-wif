import { parseArgs } from 'node:util';
import { defaultGitHubClient, defaultGoogleClient, type Exec } from '../core/clients.js';
import { resolveContext } from '../core/context.js';
import { status } from '../core/engine.js';
import { FirebaseWifError } from '../core/errors.js';
import { DEFAULT_ENVIRONMENT, DEFAULT_VARIABLE_PREFIX } from '../core/naming.js';
import type { GitHubClient, GoogleClient, Options, PresetName } from '../core/types.js';
import { PRESET_NAMES } from '../presets.js';
import { renderStatus } from './render.js';

export const USAGE = `Usage: firebase-wif [status] [options]

Commands:
  status                        Check the Firebase project and GitHub repo (default)
  setup                         Create or repair the setup (not available yet)

Options:
  --project <id|alias>          Firebase project ID or .firebaserc alias
  --repo <owner/name>           GitHub repository
  --pool <id>                   Workload identity pool ID (default: github)
  --provider <id>               Provider ID (default: github-<repoId>)
  --service-account <id|email>  Deploy service account (default: github-<repoId>)
  --preset <name>               Role preset, repeatable: ${PRESET_NAMES.join(', ')} (default: from firebase.json)
  --role <role>                 Extra project role, repeatable
  --environment <name>          GitHub environment (default: ${DEFAULT_ENVIRONMENT})
  --no-environment              Skip the GitHub environment
  --branch <name>               Branch allowed to deploy (default: the repo's default branch)
  --variable-prefix <prefix>    Repo variable prefix (default: ${DEFAULT_VARIABLE_PREFIX})
  --json                        Print the report as JSON
  --cwd <dir>                   Directory to look for firebase.json and the git remote
  -h, --help                    Show this help
`;

export interface CliDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  googleClient?: () => Promise<GoogleClient>;
  githubClient?: () => Promise<GitHubClient>;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, credentials: 3 } as const;

const exitFor = (error: FirebaseWifError) =>
  ['INVALID_NAME', 'NOT_IMPLEMENTED'].includes(error.code) ? EXIT.usage : EXIT.credentials;

/** Runs the CLI and returns its exit code. */
export const main = async (argv: string[], deps: CliDeps = {}): Promise<number> => {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        repo: { type: 'string' },
        pool: { type: 'string' },
        provider: { type: 'string' },
        'service-account': { type: 'string' },
        preset: { type: 'string', multiple: true },
        role: { type: 'string', multiple: true },
        environment: { type: 'string' },
        'no-environment': { type: 'boolean' },
        branch: { type: 'string' },
        'variable-prefix': { type: 'string' },
        json: { type: 'boolean' },
        cwd: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    stderr(`${(error as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout(USAGE);
    return EXIT.ok;
  }

  const command = positionals[0] ?? 'status';
  if (command === 'setup') {
    stderr('firebase-wif setup is not available yet. Run firebase-wif status to see what needs changing.\n');
    return EXIT.usage;
  }
  if (command !== 'status' || positionals.length > 1) {
    stderr(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const fail = (error: unknown, code: number) => {
    if (!(error instanceof FirebaseWifError)) throw error;
    if (values.json) {
      stdout(`${JSON.stringify({ error: { code: error.code, message: error.message, fix: error.fix } }, null, 2)}\n`);
    } else {
      stderr(`${error.message}${error.fix ? `\n  fix: ${error.fix}` : ''}\n`);
    }
    return code;
  };

  const unknownPreset = values.preset?.find((name) => !PRESET_NAMES.includes(name as PresetName));
  if (unknownPreset) {
    stderr(`Unknown preset "${unknownPreset}". Use one of: ${PRESET_NAMES.join(', ')}.\n`);
    return EXIT.usage;
  }
  const presets = values.preset as PresetName[] | undefined;

  let resolved;
  try {
    resolved = await resolveContext({ cwd: values.cwd ?? deps.cwd, project: values.project, repo: values.repo, env, exec: deps.exec });
  } catch (error) {
    return fail(error, EXIT.usage);
  }

  let google: GoogleClient;
  try {
    google = await (deps.googleClient ?? (() => defaultGoogleClient({ env, exec: deps.exec })))();
  } catch (error) {
    return fail(error, EXIT.credentials);
  }

  let github: GitHubClient | false;
  try {
    github = await (deps.githubClient ?? (() => defaultGitHubClient({ env, exec: deps.exec })))();
  } catch (error) {
    if (!(error instanceof FirebaseWifError)) throw error;
    stderr(`No GitHub credentials; skipping GitHub checks. Run gh auth login to include them.\n`);
    github = false;
  }

  const prefix = values['variable-prefix'] ?? DEFAULT_VARIABLE_PREFIX;
  const options: Options = {
    projectId: resolved.projectId,
    repo: resolved.repo,
    google,
    github,
    presets: presets?.length ? presets : 'auto',
    firebaseJson: resolved.firebaseJson,
    roles: values.role,
    names: { pool: values.pool, provider: values.provider, serviceAccount: values['service-account'] },
    variables: { provider: `${prefix}PROVIDER`, serviceAccount: `${prefix}SERVICE_ACCOUNT` },
    environment: values['no-environment']
      ? false
      : { name: values.environment ?? DEFAULT_ENVIRONMENT, branch: values.branch },
    local: resolved.local,
  };

  let report;
  try {
    report = await status(options);
  } catch (error) {
    return fail(error, error instanceof FirebaseWifError ? exitFor(error) : EXIT.credentials);
  }

  stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatus(report, resolved.sources));
  return report.ok ? EXIT.ok : EXIT.failed;
};
