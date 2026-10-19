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

export class FirebaseWifError extends Error {
  readonly code: ErrorCode;
  readonly fix?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: { fix?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'FirebaseWifError';
    this.code = code;
    this.fix = options.fix;
    this.details = options.details;
  }
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
