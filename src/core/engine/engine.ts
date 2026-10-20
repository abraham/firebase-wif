import type { Options, Plan, SetupOptions, SetupResult, StatusReport } from '../types.js';
import { applyChanges } from './apply.js';
import { inspect } from './inspect.js';
import { assertCanApply } from './permissions.js';

/** Read-only: every reconcile resource's diff plus the advisory checks. */
export const status = async (options: Options): Promise<StatusReport> => (await inspect(options)).report;

/** Read-only: the ordered changes `setup` would make. */
export const plan = async (options: Options): Promise<Plan> => {
  const inspection = await inspect(options);
  if (inspection.blocked[0]) throw inspection.blocked[0];
  const { report } = inspection;
  return {
    context: report.context,
    changes: report.changes,
    preflight: report.preflight,
    apply: (applyOptions) => applyChanges(options, inspection, applyOptions?.signal ?? options.signal),
  };
};

/** Plans, asks `confirm`, then applies. Throws `MISSING_PERMISSIONS` before writing anything. */
export const setup = async ({ confirm, ...options }: SetupOptions): Promise<SetupResult> => {
  const planned = await plan(options);
  assertCanApply(planned.changes, planned.preflight);
  if (confirm && !(await confirm(planned))) return { cancelled: true, plan: planned };
  return { ...(await planned.apply()), cancelled: false };
};
