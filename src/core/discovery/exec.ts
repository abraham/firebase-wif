import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type Exec = (file: string, args: string[], options?: { cwd?: string | undefined }) => Promise<string>;

const execFileAsync = promisify(execFile);

/** Runs a command without a shell and resolves with its stdout. */
export const defaultExec: Exec = async (file, args, options) =>
  (await execFileAsync(file, args, { cwd: options?.cwd })).stdout;
