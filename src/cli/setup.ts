import { plan, setup, type Options, type Plan, type SetupResult } from '../index.js';
import type { CliArgs } from './args.js';
import { EXIT, exitFor, type Outcome, type Output } from './output.js';
import type { Ask } from './prompt.js';
import { renderPlan, renderStatus, type Sources } from './render.js';

const NEXT_STEPS =
  'IAM changes can take a few minutes to take effect. Workflow examples: https://github.com/abraham/firebase-wif#usage\n';

export interface SetupContext {
  args: Pick<CliArgs, 'dryRun' | 'yes' | 'adopt' | 'prune' | 'detailed'>;
  output: Output;
  sources: Sources;
  ask: Ask;
  /** Whether prompts can be shown. */
  interactive: boolean;
}

/** The setup-only options: pruning, adoption, and progress lines. */
const setupOptions = (options: Options, { args, output, ask, interactive }: SetupContext): Options => ({
  ...options,
  prune: args.prune,
  adopt: args.adopt
    ? true
    : interactive &&
      ((candidate) =>
        ask(
          `Adopt ${candidate.provider} and ${candidate.serviceAccount} from ${candidate.variables.provider} and ${candidate.variables.serviceAccount}?`,
        )),
  ...(output.json
    ? {}
    : {
        onEvent: (event) => {
          if (event.type === 'change:done')
            output.stdout(`  ✓ ${args.detailed ? event.change.description : event.change.summary}\n`);
          if (event.type === 'retry') {
            const delay = `retrying in ${Math.round(event.delayMs / 1000)}s`;
            output.stdout(`    ${args.detailed ? `${delay}: ${event.reason}` : delay}\n`);
          }
        },
      }),
});

const dryRun = async (options: Options, { args, output, sources }: SetupContext): Promise<Outcome> => {
  try {
    const planned = await plan(options);
    const { context, changes, preflight } = planned;
    if (output.json) output.emit({ context, changes, preflight });
    else output.stdout(renderPlan(planned, sources, args.detailed));
    return { code: EXIT.ok, context };
  } catch (error) {
    return { code: output.fail(error, exitFor(error)) };
  }
};

/** Runs `setup` (or `plan` for `--dry-run`) for one project, asking before it writes. */
export const runSetup = async (base: Options, ctx: SetupContext): Promise<Outcome> => {
  const { args, output, sources, ask, interactive } = ctx;
  const options = setupOptions(base, ctx);
  if (args.dryRun) return dryRun(options, ctx);

  // Why `confirm` declined, since `setup` only reports that it was cancelled.
  let declined: Outcome = { code: EXIT.failed };
  const confirm = async (planned: Plan): Promise<boolean> => {
    if (!output.json) output.stdout(renderPlan(planned, sources, args.detailed));
    if (!planned.changes.length && !output.json) {
      declined = { code: EXIT.ok, context: planned.context };
      return false;
    }
    if (args.yes || planned.changes.every((change) => change.manual)) return true;
    if (!interactive) {
      output.stderr('Pass --yes to apply changes without a prompt.\n');
      declined = { code: EXIT.usage };
      return false;
    }
    if (!(await ask('Apply these changes?'))) {
      output.stdout('Cancelled; nothing changed.\n');
      declined = { code: EXIT.failed };
      return false;
    }
    return true;
  };

  let result: SetupResult;
  try {
    result = await setup({ ...options, confirm });
  } catch (error) {
    return { code: output.fail(error, exitFor(error)) };
  }
  if (result.cancelled) return declined;

  const { cancelled: _, ...applied } = result;
  if (output.json) {
    output.emit(applied);
  } else {
    output.stdout(`\n${renderStatus(result.status, sources, args.detailed)}`);
    if (result.manual.length)
      output.stdout(`Do by hand:\n${result.manual.map((change) => `  - ${change.description}\n`).join('')}`);
    if (result.applied.length) output.stdout(NEXT_STEPS);
  }
  return { code: result.status.ok ? EXIT.ok : EXIT.failed, context: result.status.context };
};
