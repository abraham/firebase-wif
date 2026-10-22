import { readFile } from 'node:fs/promises';
import {
  projectAliases,
  resolveContext,
  type Exec,
  type GitHubClient,
  type GoogleClient,
  type Options,
} from '../index.js';
import { parseCli, USAGE, type CliArgs } from './args.js';
import { connect } from './clients.js';
import { buildOptions } from './options.js';
import { createOutput, EXIT, type Output } from './output.js';
import { askOnTerminal, createAsk, type Prompt } from './prompt.js';
import { runSetup } from './setup.js';
import { runStatus } from './status.js';

export interface CliDeps {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  stdout?: ((text: string) => void) | undefined;
  stderr?: ((text: string) => void) | undefined;
  googleClient?: (() => Promise<GoogleClient>) | undefined;
  githubClient?: (() => Promise<GitHubClient>) | undefined;
  /** Whether prompts can be shown; defaults to stdin and stdout being terminals. */
  interactive?: boolean | undefined;
  prompt?: Prompt | undefined;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal | undefined;
}

export { EXIT, USAGE };

const readVersion = async (): Promise<string> => {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return version;
};

/** Runs the CLI and returns its exit code. */
export const main = async (argv: string[], deps: CliDeps = {}): Promise<number> => {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));

  const parsed = parseCli(argv);
  switch (parsed.kind) {
    case 'help':
      stdout(USAGE);
      return EXIT.ok;
    case 'version':
      stdout(`${await readVersion()}\n`);
      return EXIT.ok;
    case 'usage-error':
      stderr(parsed.message);
      return EXIT.usage;
  }

  const { args } = parsed;
  const output = createOutput({ stdout, stderr, json: args.json, all: args.allAliases, signal: deps.signal });
  const code = await run(args, deps, output);
  output.flush();
  return code;
};

/** The `.firebaserc` aliases to run, or the exit code when there are none. */
const targetsFor = async (args: CliArgs, cwd: string | undefined, output: Output) => {
  if (!args.allAliases) return [args.project];
  let aliases;
  try {
    aliases = await projectAliases({ cwd });
  } catch (error) {
    return output.fail(error, EXIT.usage);
  }
  if (!aliases.length) {
    output.stderr('--all-aliases needs project aliases in .firebaserc.\n');
    return EXIT.usage;
  }
  return aliases.map((entry) => entry.alias);
};

const run = async (args: CliArgs, deps: CliDeps, output: Output): Promise<number> => {
  const env = deps.env ?? process.env;
  const cwd = args.cwd ?? deps.cwd;
  const targets = await targetsFor(args, cwd, output);
  if (typeof targets === 'number') return targets;

  const connection = await connect({ ...deps, env }, output);
  if (connection.kind === 'failed') return connection.code;
  const { google, github } = connection;

  const interactive = (deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)) && !args.json;
  const ask = createAsk(deps.prompt ?? askOnTerminal, deps.signal);
  // Later aliases reuse the first one's provider and service account (docs/multi-project.md).
  let home: Options['home'];
  let worst: number = EXIT.ok;

  for (const [index, target] of targets.entries()) {
    output.setAlias(target);
    if (index > 0 && !args.json) output.stdout('\n');
    let resolved;
    try {
      resolved = await resolveContext({ cwd, project: target, repo: args.repo, env, exec: deps.exec });
    } catch (error) {
      return output.fail(error, EXIT.usage);
    }

    const options = buildOptions({ args, resolved, google, github, signal: deps.signal, home });
    const { sources } = resolved;
    const outcome =
      args.command === 'setup'
        ? await runSetup(options, { args, output, sources, ask, interactive })
        : await runStatus(options, { output, sources, detailed: args.detailed });

    worst = Math.max(worst, outcome.code);
    // Without a home context to share, later aliases would plan a chain of their own.
    if (!outcome.context) return worst;
    home ??= { provider: outcome.context.provider, serviceAccount: outcome.context.serviceAccount };
  }
  return worst;
};
