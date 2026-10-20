import { FirebaseWifError, type Context } from '../index.js';

export const EXIT = { ok: 0, failed: 1, usage: 2, credentials: 3, interrupted: 130 } as const;

/** How one project's run ended, and its context when later aliases can share its trust chain. */
export interface Outcome {
  code: number;
  context?: Context | undefined;
}

export const exitFor = (error: unknown): number => {
  if (!(error instanceof FirebaseWifError)) return EXIT.failed;
  switch (error.code) {
    case 'INVALID_NAME':
      return EXIT.usage;
    case 'NO_GOOGLE_CREDENTIALS':
    case 'NO_GITHUB_CREDENTIALS':
    case 'PROJECT_NOT_FOUND':
    case 'REPO_NOT_FOUND':
    case 'MISSING_PERMISSIONS':
      return EXIT.credentials;
    default:
      return EXIT.failed;
  }
};

export interface Output {
  readonly json: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Prints a JSON result, or collects it under the current alias with `--all-aliases`. */
  emit(payload: object): void;
  /** Reports an error and returns `code`, or 130 once interrupted. Rethrows errors that are bugs. */
  fail(error: unknown, code: number): number;
  setAlias(alias: string | undefined): void;
  /** Prints the collected `--all-aliases` JSON array. */
  flush(): void;
}

export const createOutput = ({
  stdout,
  stderr,
  json,
  all,
  signal,
}: {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  json: boolean;
  all: boolean;
  signal?: AbortSignal | undefined;
}): Output => {
  const collected: object[] = [];
  let alias: string | undefined;

  const emit = (payload: object) => {
    if (all) collected.push({ alias, ...payload });
    else stdout(`${JSON.stringify(payload, null, 2)}\n`);
  };

  return {
    json,
    stdout,
    stderr,
    emit,
    fail(error, code) {
      if (signal?.aborted) {
        stderr('Interrupted.\n');
        return EXIT.interrupted;
      }
      if (!(error instanceof FirebaseWifError)) throw error;
      if (json) emit({ error: { code: error.code, message: error.message, fix: error.fix } });
      else stderr(`${error.message}${error.fix ? `\n  fix: ${error.fix}` : ''}\n`);
      return code;
    },
    setAlias(next) {
      alias = next;
    },
    flush() {
      if (all && json) stdout(`${JSON.stringify(collected, null, 2)}\n`);
    },
  };
};
