import { spawn } from 'node:child_process';
import { FirebaseWifError, HttpError } from './core/errors.js';
import type { GitHubClient } from './core/types.js';

export type { GitHubClient } from './core/types.js';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh` with `args`, writing `input` to stdin. */
export type GhRunner = (args: string[], input?: string) => Promise<GhResult>;

const runGh: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });

// gh exits with 4 when it isn't signed in.
const GH_AUTH_EXIT_CODE = 4;

/** A GitHub client that sends every request through `gh api`, for tools that already rely on a signed-in gh. */
export const ghCliClient = ({ run = runGh }: { run?: GhRunner } = {}): GitHubClient => ({
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const args = [
      'api',
      path.replace(/^\//, ''),
      '--method',
      method,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      ...(body === undefined ? [] : ['--input', '-']),
    ];
    let result: GhResult;
    try {
      result = await run(args, body === undefined ? undefined : JSON.stringify(body));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FirebaseWifError('NO_GITHUB_CREDENTIALS', 'The GitHub CLI (gh) is not installed.', {
          fix: 'Install it from https://cli.github.com and run gh auth login.',
        });
      }
      throw error;
    }
    if (result.code === 0) return (result.stdout.trim() ? JSON.parse(result.stdout) : {}) as T;

    const message = result.stderr.trim().split('\n')[0]?.replace(/^gh: /, '') || `gh api exited with ${result.code}`;
    if (result.code === GH_AUTH_EXIT_CODE) {
      throw new FirebaseWifError('NO_GITHUB_CREDENTIALS', message, { fix: 'gh auth login' });
    }
    const status = /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1];
    throw status ? new HttpError(Number(status), message) : new Error(message);
  },
});
