import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { defaultGitHubClient, defaultGoogleClient, type Exec } from '../core/clients.js';
import { projectAliases, resolveContext } from '../core/context.js';
import { assertCanApply, plan, status } from '../core/engine.js';
import { FirebaseWifError } from '../core/errors.js';
import { DEFAULT_ENVIRONMENT, DEFAULT_VARIABLE_PREFIX } from '../core/naming.js';
import type { ApplyResult, Context, GitHubClient, GoogleClient, Options, Plan, PresetName } from '../core/types.js';
import { PRESET_NAMES } from '../presets.js';
import { renderPlan, renderStatus, type Sources } from './render.js';

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
  --scheduler                   Add roles/cloudscheduler.admin to the functions preset
  --runtime-service-account <email>
                                Functions runtime service account, repeatable (default: the compute default)
  --environment <name>          GitHub environment (default: ${DEFAULT_ENVIRONMENT})
  --no-environment              Skip the GitHub environment
  --branch <name>               Branch allowed to deploy (default: the repo's default branch)
  --variable-prefix <prefix>    Repo variable prefix (default: ${DEFAULT_VARIABLE_PREFIX})
  --json                        Print JSON
  --cwd <dir>                   Directory to look for firebase.json and the git remote
  -h, --help                    Show this help

Setup options:
  --dry-run                     Print the plan without changing anything
  -y, --yes                     Apply without asking (required when stdin isn't a terminal)
  --adopt                       Adopt a setup found through legacy repo variables without asking
  --prune                       Remove unrequested roles from a service account firebase-wif manages
`;

export interface CliDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  googleClient?: () => Promise<GoogleClient>;
  githubClient?: () => Promise<GitHubClient>;
  /** Whether prompts can be shown; defaults to stdin and stdout being terminals. */
  interactive?: boolean;
  prompt?: (question: string) => Promise<boolean>;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, credentials: 3 } as const;

const NEXT_STEPS =
  'IAM changes can take a few minutes to take effect. Workflow examples: https://github.com/abraham/firebase-wif#usage\n';

const exitFor = (error: unknown): number => {
  if (!(error instanceof FirebaseWifError)) return EXIT.failed;
  switch (error.code) {
    case 'INVALID_NAME':
      return EXIT.usage;
    case 'NO_GOOGLE_CREDENTIALS':
    case 'NO_GITHUB_CREDENTIALS':
    case 'PROJECT_NOT_FOUND':
    case 'REPO_NOT_FOUND':
    case 'MISSING_PERMISSIONS':
      return EXIT.credentials;
    default:
      return EXIT.failed;
  }
};

const askOnTerminal = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

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
        'all-aliases': { type: 'boolean' },
        repo: { type: 'string' },
        pool: { type: 'string' },
        provider: { type: 'string' },
        'service-account': { type: 'string' },
        preset: { type: 'string', multiple: true },
        role: { type: 'string', multiple: true },
        scheduler: { type: 'boolean' },
        'runtime-service-account': { type: 'string', multiple: true },
        environment: { type: 'string' },
        'no-environment': { type: 'boolean' },
        branch: { type: 'string' },
        'variable-prefix': { type: 'string' },
        json: { type: 'boolean' },
        cwd: { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        adopt: { type: 'boolean' },
        prune: { type: 'boolean' },
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
  if (!['status', 'setup'].includes(command) || positionals.length > 1) {
    stderr(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const setupOnly = (['dry-run', 'yes', 'adopt', 'prune'] as const).filter((flag) => values[flag]);
  if (command === 'status' && setupOnly.length) {
    stderr(`--${setupOnly[0]} only works with setup.\n`);
    return EXIT.usage;
  }

  // With --all-aliases, JSON output is one array with an entry per alias.
  const all = Boolean(values['all-aliases']);
  const collected: object[] = [];
  let alias: string | undefined;
  const emit = (payload: object) => {
    if (all) collected.push({ alias, ...payload });
    else stdout(`${JSON.stringify(payload, null, 2)}\n`);
  };

  const fail = (error: unknown, code: number) => {
    if (!(error instanceof FirebaseWifError)) throw error;
    if (values.json) {
      emit({ error: { code: error.code, message: error.message, fix: error.fix } });
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
  const cwd = values.cwd ?? deps.cwd;

  const run = async (): Promise<number> => {
    let targets: (string | undefined)[] = [values.project];
    if (all) {
      if (values.project) {
        stderr('Pass either --project or --all-aliases, not both.\n');
        return EXIT.usage;
      }
      let aliases;
      try {
        aliases = await projectAliases({ cwd });
      } catch (error) {
        return fail(error, EXIT.usage);
      }
      if (!aliases.length) {
        stderr('--all-aliases needs project aliases in .firebaserc.\n');
        return EXIT.usage;
      }
      targets = aliases.map((entry) => entry.alias);
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
    const interactive = (deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)) && !values.json;
    const ask = deps.prompt ?? askOnTerminal;
    // Later aliases reuse the first one's provider and service account (5.8).
    let home: Options['home'];
    let worst: number = EXIT.ok;

    for (const [index, target] of targets.entries()) {
      alias = target;
      if (index > 0 && !values.json) stdout('\n');
      let resolved;
      try {
        resolved = await resolveContext({ cwd, project: target, repo: values.repo, env, exec: deps.exec });
      } catch (error) {
        return fail(error, EXIT.usage);
      }

      const options: Options = {
        projectId: resolved.projectId,
        repo: resolved.repo,
        google,
        github,
        presets: presets?.length ? presets : 'auto',
        firebaseJson: resolved.firebaseJson,
        roles: values.role,
        scheduler: values.scheduler,
        runtimeServiceAccounts: values['runtime-service-account'],
        names: { pool: values.pool, provider: values.provider, serviceAccount: values['service-account'] },
        variables: { provider: `${prefix}PROVIDER`, serviceAccount: `${prefix}SERVICE_ACCOUNT` },
        environment: values['no-environment']
          ? false
          : { name: values.environment ?? DEFAULT_ENVIRONMENT, branch: values.branch },
        local: resolved.local,
        ...(home ? { home } : {}),
      };

      const outcome =
        command === 'setup'
          ? await runSetup({
              options: {
                ...options,
                prune: values.prune,
                adopt: values.adopt
                  ? true
                  : interactive &&
                    ((candidate) =>
                      ask(
                        `Adopt ${candidate.provider} and ${candidate.serviceAccount} from ${candidate.variables.provider} and ${candidate.variables.serviceAccount}?`,
                      )),
                ...(values.json
                  ? {}
                  : {
                      onEvent: (event) => {
                        if (event.type === 'change:done') stdout(`  ✓ ${event.change.description}\n`);
                        if (event.type === 'retry')
                          stdout(`    retrying in ${Math.round(event.delayMs / 1000)}s: ${event.reason}\n`);
                      },
                    }),
              },
              flags: { dryRun: Boolean(values['dry-run']), yes: Boolean(values.yes), json: Boolean(values.json) },
              interactive,
              ask,
              sources: resolved.sources,
              stdout,
              stderr,
              emit,
              fail,
            })
          : await runStatus(options, resolved.sources);

      worst = Math.max(worst, outcome.code);
      // Without a home context to share, later aliases would plan a chain of their own.
      if (!outcome.context) return worst;
      home ??= { provider: outcome.context.provider, serviceAccount: outcome.context.serviceAccount };
    }
    return worst;
  };

  const runStatus = async (options: Options, sources: Sources): Promise<Outcome> => {
    let report;
    try {
      // Status follows a legacy setup, so it reports what setup --adopt would do.
      report = await status({ ...options, adopt: true });
    } catch (error) {
      return { code: fail(error, exitFor(error)) };
    }
    if (values.json) emit(report);
    else stdout(renderStatus(report, sources));
    return { code: report.ok ? EXIT.ok : EXIT.failed, context: report.context };
  };

  const code = await run();
  if (all && values.json) stdout(`${JSON.stringify(collected, null, 2)}\n`);
  return code;
};

interface Outcome {
  code: number;
  /** Set when the project was checked or set up, so later aliases can share its trust chain. */
  context?: Context;
}

const runSetup = async ({
  options,
  flags,
  interactive,
  ask,
  sources,
  stdout,
  stderr,
  emit,
  fail,
}: {
  options: Options;
  flags: { dryRun: boolean; yes: boolean; json: boolean };
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  sources: Sources;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  emit: (payload: object) => void;
  fail: (error: unknown, code: number) => number;
}): Promise<Outcome> => {
  let planned: Plan;
  try {
    planned = await plan(options);
  } catch (error) {
    return { code: fail(error, exitFor(error)) };
  }
  const { context } = planned;

  if (flags.json && flags.dryRun) {
    const { changes, preflight } = planned;
    emit({ context, changes, preflight });
    return { code: EXIT.ok, context };
  }
  if (!flags.json) stdout(renderPlan(planned, sources));
  if (flags.dryRun || (!planned.changes.length && !flags.json)) return { code: EXIT.ok, context };

  if (planned.changes.some((change) => !change.manual)) {
    try {
      assertCanApply(planned.changes, planned.preflight);
    } catch (error) {
      return { code: fail(error, exitFor(error)) };
    }
    if (!flags.yes) {
      if (!interactive) {
        stderr('Pass --yes to apply changes without a prompt.\n');
        return { code: EXIT.usage };
      }
      if (!(await ask('Apply these changes?'))) {
        stdout('Cancelled; nothing changed.\n');
        return { code: EXIT.failed };
      }
    }
  }

  let result: ApplyResult;
  try {
    result = await planned.apply();
  } catch (error) {
    return { code: fail(error, exitFor(error)) };
  }

  if (flags.json) {
    emit(result);
  } else {
    stdout(`\n${renderStatus(result.status, sources)}`);
    if (result.manual.length)
      stdout(`Do by hand:\n${result.manual.map((change) => `  - ${change.description}\n`).join('')}`);
    if (result.applied.length) stdout(NEXT_STEPS);
  }
  return { code: result.status.ok ? EXIT.ok : EXIT.failed, context: result.status.context };
};
