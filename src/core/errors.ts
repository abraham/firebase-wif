import type { Change } from './types.js';

/** The change that failed while applying, and every change applied before it. */
export interface ApplyFailure {
  failed: Change;
  applied: Change[];
}

export interface ErrorDetails {
  NO_GOOGLE_CREDENTIALS: undefined;
  NO_GITHUB_CREDENTIALS: undefined;
  INVALID_NAME: undefined;
  PROJECT_NOT_FOUND: undefined;
  REPO_NOT_FOUND: undefined;
  MISSING_PERMISSIONS: { missingPermissions: string[] };
  PROVIDER_OWNED_BY_OTHER_REPO: ApplyFailure | undefined;
  ORG_POLICY_BLOCKS_ISSUER: ApplyFailure;
  OPERATION_TIMEOUT: ApplyFailure;
  APPLY_FAILED: ApplyFailure;
  VERIFY_FAILED: { stage: 'oidc' | 'sts' | 'impersonation'; status: number };
}

export type ErrorCode = keyof ErrorDetails;

/** `details` is required exactly when the code's details can't be `undefined`. */
type ErrorOptions<C extends ErrorCode> = undefined extends ErrorDetails[C]
  ? [options?: { fix?: string | undefined; details?: ErrorDetails[C] }]
  : [options: { fix?: string | undefined; details: ErrorDetails[C] }];

export class FirebaseWifError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly fix: string | undefined;
  readonly details: ErrorDetails[C];

  constructor(code: C, message: string, ...[options]: ErrorOptions<C>) {
    super(message);
    this.name = 'FirebaseWifError';
    this.code = code;
    this.fix = options?.fix;
    // ErrorOptions guarantees this for every concrete code; TypeScript can't follow it through the generic.
    this.details = options?.details as ErrorDetails[C];
  }
}

/** Narrows `error` to a `FirebaseWifError`, and to `code` when given. */
export function isFirebaseWifError<C extends ErrorCode = ErrorCode>(
  error: unknown,
  code?: C,
): error is FirebaseWifError<C> {
  return error instanceof FirebaseWifError && (code === undefined || error.code === code);
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Thrown by a write that stops `apply`; the engine turns it into a `FirebaseWifError` with `ApplyFailure` details. */
export class WriteError extends Error {
  readonly code: 'ORG_POLICY_BLOCKS_ISSUER' | 'OPERATION_TIMEOUT';
  readonly fix: string;

  constructor(code: WriteError['code'], message: string, fix: string) {
    super(message);
    this.name = 'WriteError';
    this.code = code;
    this.fix = fix;
  }
}

export const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

export const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
};
