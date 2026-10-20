import { FirebaseWifError, HttpError } from '../errors.js';
import type { GitHubAuth, GitHubClient, GoogleAuth, GoogleClient } from '../types.js';
import { defaultExec, type Exec } from './exec.js';

type Fetch = typeof globalThis.fetch;

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

/** The content-type header and body for a JSON request, or neither for a request without a body. */
const jsonBody = (body: unknown): { headers: Record<string, string>; init: { body?: string } } =>
  body === undefined
    ? { headers: {}, init: {} }
    : { headers: { 'content-type': 'application/json' }, init: { body: JSON.stringify(body) } };

export const createGoogleClient = ({
  getAccessToken,
  fetch = globalThis.fetch,
}: {
  getAccessToken: () => Promise<string>;
  fetch?: Fetch | undefined;
}): GoogleClient => ({
  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const token = await getAccessToken();
    const json = jsonBody(body);
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...json.headers },
      ...json.init,
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
  token?: string | undefined;
  fetch?: Fetch | undefined;
} = {}): GitHubClient => ({
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const json = jsonBody(body);
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'firebase-wif',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...json.headers,
      },
      ...json.init,
    });
    const data = await readJson(response);
    if (!response.ok) throw new HttpError(response.status, errorMessage(data, response.statusText));
    return data as T;
  },
});

const isGoogleClient = (auth: GoogleAuth): auth is GoogleClient => 'request' in auth;

const isGitHubClient = (auth: GitHubAuth): auth is GitHubClient => 'request' in auth;

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
}: {
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  fetch?: Fetch | undefined;
} = {}): Promise<GoogleClient> => {
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
}: {
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  fetch?: Fetch | undefined;
} = {}): Promise<GitHubClient> => {
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
