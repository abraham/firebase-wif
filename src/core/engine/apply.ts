import { FirebaseWifError, isAbortError, isFirebaseWifError, statusOf, WriteError } from '../errors.js';
import { createMemo, type Runtime } from '../io/reads.js';
import { defaultSleep, type Writer } from '../io/writes.js';
import { RESOURCES } from '../resources/registry.js';
import type { ApplyResult, Change, Options } from '../types.js';
import { evaluate, inspect, readVariables, withSignal, type Inspection } from './inspect.js';
import { assertCanApply } from './permissions.js';

/** Turns a failed write into the error `apply` throws, saying what was already applied. */
export const applyError = (error: unknown, failed: Change, applied: Change[]): unknown => {
  if (isAbortError(error)) return error;
  const done = applied.length ? ` Already applied: ${applied.map((c) => c.description).join('; ')}.` : '';
  const details = { failed, applied: [...applied] };
  if (error instanceof WriteError || isFirebaseWifError(error, 'PROVIDER_OWNED_BY_OTHER_REPO'))
    return new FirebaseWifError(error.code, `${error.message}${done}`, { fix: error.fix, details });
  if (error instanceof FirebaseWifError) return error;
  const status = statusOf(error);
  const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
  return new FirebaseWifError(
    'APPLY_FAILED',
    `Couldn't ${failed.description}${status ? ` (${status})` : ''}: ${reason}.${done}`,
    {
      fix: 'Fix the cause, then re-run firebase-wif setup; every step is safe to repeat.',
      details,
    },
  );
};

/** Re-reads and applies each resource in order, then re-runs status. */
export const applyChanges = async (
  options: Options,
  inspection: Inspection,
  signal: AbortSignal | undefined,
): Promise<ApplyResult> => {
  const { runtime: base, report } = inspection;
  assertCanApply(report.changes, report.preflight);
  const google = withSignal(base.google, signal);
  const github = base.github && withSignal(base.github, signal);
  const w: Writer = {
    sleep: options.sleep ?? defaultSleep,
    emit: (event) => options.onEvent?.(event),
    signal,
    createdServiceAccount: false,
  };

  const applied: Change[] = [];
  const manual: Change[] = [];
  for (const resource of RESOURCES) {
    let pending: Change[] = [];
    const done = new Set<string>();
    // A second pass covers follow-up changes, like patching a provider right after restoring it.
    for (let pass = 0; pass < 2; pass++) {
      signal?.throwIfAborted();
      const rt: Runtime = {
        ...base,
        google,
        github,
        memo: createMemo(),
        variableValues:
          resource.id === 'gh.variables'
            ? await readVariables(github, base.ctx.repo, base.ctx.variables)
            : base.variableValues,
      };
      const outcome = await evaluate(resource, rt);
      if (outcome.kind === 'blocked')
        throw applyError(
          outcome.error,
          { resource: resource.id, action: 'update', description: outcome.message, summary: outcome.message },
          applied,
        );
      const changes =
        outcome.kind === 'drift' ? outcome.changes : outcome.kind === 'skipped' ? (outcome.changes ?? []) : [];
      pending = changes.filter((c) => c.manual);
      // Reads can lag a write (a new provider can 404 for a moment), so don't redo what just succeeded.
      const automatic = changes.filter((c) => !c.manual && !done.has(c.description));
      if (!automatic.length) break;

      for (const change of automatic) w.emit({ type: 'change:start', change });
      try {
        await resource.apply(rt, w);
      } catch (error) {
        throw applyError(error, automatic[0]!, applied);
      }
      for (const change of automatic) {
        done.add(change.description);
        applied.push(change);
        w.emit({ type: 'change:done', change });
      }
    }
    manual.push(...pending);
  }

  const { report: after } = await inspect({
    ...options,
    google: base.google,
    github: base.github ?? false,
    adopt: Boolean(base.ctx.adopted),
    signal,
  });
  return { applied, manual, status: after };
};
