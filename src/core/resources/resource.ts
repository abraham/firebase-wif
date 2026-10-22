import type { FirebaseWifError } from '../errors.js';
import type { Runtime } from '../io/reads.js';
import type { Writer } from '../io/writes.js';
import { addMember, type Policy } from '../policy.js';
import type { Change, ChangeAction, ResourceId } from '../types.js';

export type Outcome =
  | { kind: 'ok'; message: string }
  | { kind: 'drift'; message: string; changes: Change[]; fix?: string }
  | { kind: 'skipped'; message: string; changes?: Change[] }
  | { kind: 'blocked'; message: string; fix: string; error: FirebaseWifError };

/** A resource `setup` reconciles; its check fails exactly when its plan has changes. */
export interface Resource {
  id: ResourceId;
  severity: 'fail' | 'warn';
  /** `project` resources are reconciled in every project; `trust-chain` ones only in the home project. */
  scope: 'project' | 'trust-chain';
  evaluate(rt: Runtime): Promise<Outcome>;
  /** Makes the non-manual changes `evaluate` reported, re-reading through the same fresh runtime. */
  apply(rt: Runtime, w: Writer): Promise<void>;
}

export const change = (
  resource: ResourceId,
  action: ChangeAction,
  description: string,
  summary: string,
  manual = false,
): Change => (manual ? { resource, action, description, summary, manual } : { resource, action, description, summary });

export const drift = (changes: Change[], fix?: string): Outcome => ({
  kind: 'drift',
  message: changes.map((c) => c.description).join('; '),
  changes,
  ...(fix ? { fix } : {}),
});

export const ADMIN_FIX = 'Ask a repo admin to run firebase-wif setup, or make these changes by hand.';

/** A policy change that grants `role` to `member`, or nothing when it's already granted. */
export const grant = (role: string, member: string) => (policy: Policy) => {
  const next = addMember(policy, role, member);
  return next === policy ? undefined : next;
};
