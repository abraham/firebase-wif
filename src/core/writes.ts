import { isAbortError, statusOf, WriteError } from './errors.js';
import type { Policy } from './policy.js';
import type { GoogleClient, ProgressEvent } from './types.js';

/** What `apply` needs beyond a runtime: timing, events, and what earlier steps did. */
export interface Writer {
  sleep(ms: number): Promise<void>;
  emit(event: ProgressEvent): void;
  signal?: AbortSignal | undefined;
  /** IAM is eventually consistent for service accounts created in this run. */
  createdServiceAccount: boolean;
}

export interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
}

export const POLL_INTERVAL_MS = 2_000;
export const POLL_ATTEMPTS = 30;
export const MAX_RETRIES = 5;
export const PROPAGATION_DELAY_MS = 5_000;

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const pause = async (w: Writer, ms: number) => {
  await w.sleep(ms);
  w.signal?.throwIfAborted();
};

/** Polls a long-running operation every 2s for up to 60s. `base` is the API root its name is relative to. */
export const waitForOperation = async (
  w: Writer,
  google: GoogleClient,
  base: string,
  operation: Operation,
  label: string,
): Promise<void> => {
  let current = operation;
  for (let attempt = 1; !current.done; attempt++) {
    if (attempt > POLL_ATTEMPTS || !current.name) {
      throw new WriteError(
        'OPERATION_TIMEOUT',
        `Timed out waiting to ${label}.`,
        'Re-run firebase-wif setup; it picks up where it stopped.',
      );
    }
    w.emit({ type: 'operation:wait', name: label, attempt });
    await pause(w, POLL_INTERVAL_MS);
    current = await google.request<Operation>('GET', `${base}/${current.name}`);
  }
  if (current.error) throw new Error(current.error.message ?? `operation ${current.name} failed`);
};

/** Retries `run` while `delayFor` returns a delay, up to `MAX_RETRIES` times. */
export const retry = async <T>(
  w: Writer,
  reason: string,
  run: () => Promise<T>,
  delayFor: (error: unknown, attempt: number) => number | undefined,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (isAbortError(error)) throw error;
      const delayMs = attempt <= MAX_RETRIES ? delayFor(error, attempt) : undefined;
      if (delayMs === undefined) throw error;
      w.emit({ type: 'retry', reason, attempt, delayMs });
      await pause(w, delayMs);
    }
  }
};

const isConflict = (error: unknown) =>
  statusOf(error) === 409 || (error instanceof Error && /\bABORTED\b/.test(error.message));

/**
 * Read-modify-write of an IAM policy. `change` returns the new policy, or `undefined` when nothing needs
 * to change. Retries etag conflicts, and 400/404 while a just-created service account propagates.
 */
export const updatePolicy = (
  w: Writer,
  google: GoogleClient,
  {
    resource,
    getBody,
    label,
    change,
  }: {
    /** Full URL without the `:getIamPolicy` suffix. */
    resource: string;
    getBody?: unknown;
    label: string;
    change: (policy: Policy) => Policy | undefined;
  },
): Promise<void> =>
  retry(
    w,
    label,
    async () => {
      const current = await google.request<Policy>('POST', `${resource}:getIamPolicy`, getBody);
      const next = change(current);
      if (next) await google.request('POST', `${resource}:setIamPolicy`, { policy: next });
    },
    (error, attempt) => {
      if (isConflict(error)) return 1_000 * attempt + Math.floor(Math.random() * 500);
      if (w.createdServiceAccount && [400, 404].includes(statusOf(error) ?? 0)) return PROPAGATION_DELAY_MS;
      return undefined;
    },
  );
