import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubClient,
  createGoogleClient,
  defaultGitHubClient,
  defaultGoogleClient,
  toGitHubClient,
  toGoogleClient,
} from '../../src/core/clients.js';
import { HttpError } from '../../src/core/errors.js';

const adc = vi.hoisted(() => ({ token: undefined as string | undefined, fail: false }));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      if (adc.fail) throw new Error('Could not load the default credentials');
      return { getAccessToken: async () => ({ token: adc.token }) };
    }
  },
}));

const echoFetch = () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith('/missing'))
      return new Response(JSON.stringify({ error: { message: 'Not found: missing' } }), { status: 404 });
    if (url.endsWith('/text-error'))
      return new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' });
    if (url.endsWith('/github-error'))
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    if (url.endsWith('/empty')) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ auth: new Headers(init.headers).get('authorization') }), { status: 200 });
  });
  return { requests, fetch: fetch as unknown as typeof globalThis.fetch };
};

afterEach(() => {
  adc.token = undefined;
  adc.fail = false;
  vi.restoreAllMocks();
});

describe('createGoogleClient', () => {
  it('sends JSON with a bearer token', async () => {
    const { requests, fetch } = echoFetch();
    const google = createGoogleClient({ getAccessToken: async () => 'token', fetch });

    expect(await google.request('POST', 'https://example.test/ok', { a: 1 })).toEqual({ auth: 'Bearer token' });
    const headers = new Headers(requests[0]!.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(requests[0]!.init.body).toBe('{"a":1}');

    await google.request('GET', 'https://example.test/ok');
    expect(new Headers(requests[1]!.init.headers).has('content-type')).toBe(false);
    expect(requests[1]!.init.body).toBeUndefined();
  });

  it('raises HttpError with the status and API message', async () => {
    const { fetch } = echoFetch();
    const google = createGoogleClient({ getAccessToken: async () => 'token', fetch });
    await expect(google.request('GET', 'https://example.test/missing')).rejects.toEqual(
      new HttpError(404, 'Not found: missing'),
    );
    await expect(google.request('GET', 'https://example.test/text-error')).rejects.toMatchObject({
      status: 502,
      message: '<html>Bad gateway</html>',
    });
    expect(await google.request('DELETE', 'https://example.test/empty')).toEqual({});
  });
});

describe('createGitHubClient', () => {
  it('calls the GitHub API with versioned headers', async () => {
    const { requests, fetch } = echoFetch();
    const github = createGitHubClient({ token: 'gh', fetch });
    expect(await github.request('GET', '/repos/o/r')).toEqual({ auth: 'Bearer gh' });
    expect(requests[0]!.url).toBe('https://api.github.com/repos/o/r');
    const headers = new Headers(requests[0]!.init.headers);
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    await expect(github.request('GET', '/github-error')).rejects.toEqual(new HttpError(401, 'Bad credentials'));
  });

  it('works without a token', async () => {
    const { fetch } = echoFetch();
    expect(await createGitHubClient({ fetch }).request('GET', '/repos/o/r')).toEqual({ auth: null });
  });
});

describe('defaultGoogleClient', () => {
  it('prefers GOOGLE_OAUTH_ACCESS_TOKEN', async () => {
    const { fetch } = echoFetch();
    const exec = vi.fn(async () => 'from-gcloud\n');
    const client = await defaultGoogleClient({ env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'from-env' }, exec, fetch });
    expect(await client.request('GET', 'https://example.test')).toEqual({ auth: 'Bearer from-env' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to gcloud and refreshes its token after 50 minutes', async () => {
    const { fetch } = echoFetch();
    const tokens = ['first', 'second'];
    const exec = vi.fn(async () => `${tokens.shift()}\n`);
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);

    const client = await defaultGoogleClient({ env: {}, exec, fetch });
    expect(await client.request('GET', 'https://example.test')).toEqual({ auth: 'Bearer first' });
    now.mockReturnValue(49 * 60 * 1000);
    expect(await client.request('GET', 'https://example.test')).toEqual({ auth: 'Bearer first' });
    now.mockReturnValue(51 * 60 * 1000);
    expect(await client.request('GET', 'https://example.test')).toEqual({ auth: 'Bearer second' });
    expect(exec).toHaveBeenCalledWith('gcloud', ['auth', 'print-access-token']);
  });

  it('falls back to Application Default Credentials', async () => {
    const { fetch } = echoFetch();
    adc.token = 'from-adc';
    const client = await defaultGoogleClient({ env: {}, exec: async () => '', fetch });
    expect(await client.request('GET', 'https://example.test')).toEqual({ auth: 'Bearer from-adc' });
  });

  it('explains how to log in when nothing works', async () => {
    adc.fail = true;
    await expect(
      defaultGoogleClient({ env: {}, exec: async () => Promise.reject(new Error('ENOENT')) }),
    ).rejects.toMatchObject({
      code: 'NO_GOOGLE_CREDENTIALS',
      fix: 'gcloud auth login',
    });
    adc.fail = false;
    adc.token = undefined;
    await expect(defaultGoogleClient({ env: {}, exec: async () => '' })).rejects.toMatchObject({
      code: 'NO_GOOGLE_CREDENTIALS',
    });
  });
});

describe('defaultGitHubClient', () => {
  it('uses GH_TOKEN, GITHUB_TOKEN, then gh auth token', async () => {
    const { fetch } = echoFetch();
    const exec = vi.fn(async () => 'from-gh\n');
    for (const [env, expected] of [
      [{ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, 'Bearer a'],
      [{ GITHUB_TOKEN: 'b' }, 'Bearer b'],
      [{}, 'Bearer from-gh'],
    ] as const) {
      const client = await defaultGitHubClient({ env, exec, fetch });
      expect(await client.request('GET', '/user')).toEqual({ auth: expected });
    }
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'token']);
  });

  it('explains how to log in', async () => {
    const exec = vi.fn(async () => Promise.reject(new Error('gh: command not found')));
    await expect(defaultGitHubClient({ env: {}, exec })).rejects.toMatchObject({
      code: 'NO_GITHUB_CREDENTIALS',
      fix: 'gh auth login',
    });
  });
});

describe('toGoogleClient and toGitHubClient', () => {
  it('passes clients through and wraps tokens', async () => {
    const client = { request: vi.fn(async () => 'from-client' as never) };
    expect(await toGoogleClient(client)).toBe(client);
    expect(await toGitHubClient(client)).toBe(client);

    const { fetch } = echoFetch();
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await (await toGoogleClient({ accessToken: 'static' })).request('GET', 'https://example.test')).toEqual({
        auth: 'Bearer static',
      });
      expect(
        await (await toGoogleClient({ getAccessToken: async () => 'dynamic' })).request('GET', 'https://example.test'),
      ).toEqual({
        auth: 'Bearer dynamic',
      });
      expect(await (await toGitHubClient({ token: 'gh' })).request('GET', '/user')).toEqual({ auth: 'Bearer gh' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
