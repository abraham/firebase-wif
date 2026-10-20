import type { Change } from './types.js';

export type ErrorCode =
  | 'NO_GOOGLE_CREDENTIALS'
  | 'NO_GITHUB_CREDENTIALS'
  | 'INVALID_NAME'
  | 'PROJECT_NOT_FOUND'
  | 'REPO_NOT_FOUND'
  | 'MISSING_PERMISSIONS'
  | 'PROVIDER_OWNED_BY_OTHER_REPO'
  | 'ORG_POLICY_BLOCKS_ISSUER'
  | 'OPERATION_TIMEOUT'
  | 'APPLY_FAILED'
  | 'VERIFY_FAILED';

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

export class FirebaseWifError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly fix?: string;
  readonly details: ErrorDetails[C];

  // Errors raised mid-apply get their `ApplyFailure` details when the engine wraps them.
  constructor(code: C, message: string, options: { fix?: string; details?: ErrorDetails[C] } = {}) {
    super(message);
    this.name = 'FirebaseWifError';
    this.code = code;
    this.fix = options.fix;
    this.details = options.details as ErrorDetails[C];
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

export const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
};
