import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FirebaseWifError, HttpError } from './errors.js';
import type { GitHubAuth, GitHubClient, GoogleAuth, GoogleClient } from './types.js';

type Fetch = typeof globalThis.fetch;
export type Exec = (file: string, args: string[], options?: { cwd?: string }) => Promise<string>;

const execFileAsync = promisify(execFile);
export const defaultExec: Exec = async (file, args, options) =>
  (await execFileAsync(file, args, { cwd: options?.cwd })).stdout;

const GITHUB_API = 'https://api.github.com';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
// gcloud access tokens last an hour.
const GCLOUD_TOKEN_TTL_MS = 50 * 60 * 1000;

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
};

const errorMessage = (data: unknown, fallback: string): string => {
  const body = data as { error?: { message?: string } | string; message?: string } | undefined;
  if (typeof body?.error === 'object' && body.error?.message) return body.error.message;
  if (typeof body?.error === 'string') return body.error;
  return body?.message ?? fallback;
};

export const createGoogleClient = ({
  getAccessToken,
  fetch = globalThis.fetch,
}: {
  getAccessToken: () => Promise<string>;
  fetch?: Fetch;
}): GoogleClient => ({
  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const token = await getAccessToken();
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readJson(response);
    if (!response.ok) throw new HttpError(response.status, errorMessage(data, response.statusText));
    return data as T;
  },
});

export const createGitHubClient = ({
  token,
  fetch = globalThis.fetch,
}: {
  token?: string;
  fetch?: Fetch;
} = {}): GitHubClient => ({
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'firebase-wif',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readJson(response);
    if (!response.ok) throw new HttpError(response.status, errorMessage(data, response.statusText));
    return data as T;
  },
});

const isGoogleClient = (auth: GoogleAuth): auth is GoogleClient => typeof (auth as GoogleClient).request === 'function';

const isGitHubClient = (auth: GitHubAuth): auth is GitHubClient => typeof (auth as GitHubClient).request === 'function';

const tryExec = async (exec: Exec, file: string, args: string[]): Promise<string | undefined> => {
  try {
    return (await exec(file, args)).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Credential chain: `GOOGLE_OAUTH_ACCESS_TOKEN`, then `gcloud`, then Application Default Credentials. */
export const defaultGoogleClient = async ({
  env = process.env,
  exec = defaultExec,
  fetch,
}: { env?: NodeJS.ProcessEnv; exec?: Exec; fetch?: Fetch } = {}): Promise<GoogleClient> => {
  const envToken = env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (envToken) return createGoogleClient({ getAccessToken: async () => envToken, fetch });

  const gcloudToken = await tryExec(exec, 'gcloud', ['auth', 'print-access-token']);
  if (gcloudToken) {
    let token = gcloudToken;
    let fetchedAt = Date.now();
    return createGoogleClient({
      fetch,
      getAccessToken: async () => {
        if (Date.now() - fetchedAt > GCLOUD_TOKEN_TTL_MS) {
          token = (await tryExec(exec, 'gcloud', ['auth', 'print-access-token'])) ?? token;
          fetchedAt = Date.now();
        }
        return token;
      },
    });
  }

  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    const client = await auth.getClient();
    const first = await client.getAccessToken();
    if (first.token) {
      return createGoogleClient({
        fetch,
        getAccessToken: async () => {
          const { token } = await client.getAccessToken();
          if (!token)
            throw new FirebaseWifError(
              'NO_GOOGLE_CREDENTIALS',
              'Application Default Credentials returned no access token.',
            );
          return token;
        },
      });
    }
  } catch {
    // Fall through to the error below.
  }

  throw new FirebaseWifError('NO_GOOGLE_CREDENTIALS', 'No Google Cloud credentials found.', {
    fix: 'gcloud auth login',
  });
};

/** Credential chain: `GH_TOKEN`/`GITHUB_TOKEN`, then `gh auth token`. */
export const defaultGitHubClient = async ({
  env = process.env,
  exec = defaultExec,
  fetch,
}: { env?: NodeJS.ProcessEnv; exec?: Exec; fetch?: Fetch } = {}): Promise<GitHubClient> => {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || (await tryExec(exec, 'gh', ['auth', 'token']));
  if (!token) {
    throw new FirebaseWifError('NO_GITHUB_CREDENTIALS', 'No GitHub credentials found.', {
      fix: 'gh auth login',
    });
  }
  return createGitHubClient({ token, fetch });
};

export const toGoogleClient = async (auth: GoogleAuth | undefined): Promise<GoogleClient> => {
  if (!auth) return defaultGoogleClient();
  if (isGoogleClient(auth)) return auth;
  if ('accessToken' in auth) {
    const { accessToken } = auth;
    return createGoogleClient({ getAccessToken: async () => accessToken });
  }
  return createGoogleClient({ getAccessToken: auth.getAccessToken });
};

export const toGitHubClient = async (auth: GitHubAuth | undefined): Promise<GitHubClient> => {
  if (!auth) return defaultGitHubClient();
  if (isGitHubClient(auth)) return auth;
  return createGitHubClient({ token: auth.token });
};
