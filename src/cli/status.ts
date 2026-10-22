import { status, type Options } from '../index.js';
import { EXIT, exitFor, type Outcome, type Output } from './output.js';
import { renderStatus, type Sources } from './render.js';

/** Runs `status` for one project and prints the report. */
export const runStatus = async (
  options: Options,
  { output, sources, detailed }: { output: Output; sources: Sources; detailed: boolean },
): Promise<Outcome> => {
  let report;
  try {
    // Status follows a legacy setup, so it reports what setup --adopt would do.
    report = await status({ ...options, adopt: true });
  } catch (error) {
    return { code: output.fail(error, exitFor(error)) };
  }
  if (output.json) output.emit(report);
  else output.stdout(renderStatus(report, sources, detailed));
  return { code: report.ok ? EXIT.ok : EXIT.failed, context: report.context };
};
