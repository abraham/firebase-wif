import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCredentialsConfig, parseProviderName, verifyCredentials } from '../src/credentials.js';

const PROVIDER = 'projects/123/locations/global/workloadIdentityPools/github/providers/github-42';
const SA = 'github-42@demo-project.iam.gserviceaccount.com';
const REQUEST_URL = 'https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0';

const config = (audience?: string) =>
  createCredentialsConfig({
    provider: PROVIDER,
    serviceAccount: SA,
    audience,
    requestUrl: REQUEST_URL,
    requestToken: 'request-token',
  });

describe('createCredentialsConfig', () => {
  it('builds the external_account config google-github-actions/auth writes', () => {
    expect(config()).toEqual({
      type: 'external_account',
      audience: `//iam.googleapis.com/${PROVIDER}`,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
      credential_source: {
        url: `https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0&audience=${encodeURIComponent(`https://iam.googleapis.com/${PROVIDER}`)}`,
        headers: { Authorization: 'Bearer request-token' },
        format: { type: 'json', subject_token_field_name: 'value' },
      },
    });
  });

  it('uses a custom audience for the OIDC token only', () => {
    const custom = config('https://example.com/aud');
    expect(new URL(custom.credential_source.url).searchParams.get('audience')).toBe('https://example.com/aud');
    expect(custom.audience).toBe(`//iam.googleapis.com/${PROVIDER}`);
  });

  it('validates the provider and service account', () => {
    expect(() =>
      createCredentialsConfig({ provider: 'github', serviceAccount: SA, requestUrl: REQUEST_URL, requestToken: 't' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_NAME' }));
    expect(() =>
      createCredentialsConfig({
        provider: PROVIDER,
        serviceAccount: 'nope',
        requestUrl: REQUEST_URL,
        requestToken: 't',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_NAME' }));
  });
});

describe('parseProviderName', () => {
  it('splits a provider resource name', () => {
    expect(parseProviderName(PROVIDER)).toEqual({ projectNumber: '123', pool: 'github', provider: 'github-42' });
    expect(parseProviderName('github')).toBeUndefined();
  });
});

type Reply = { status: number; body: unknown };

/** Fakes GitHub's token endpoint, STS, and IAM Credentials; records each request. */
const backend = ({
  oidc,
  sts,
  impersonation,
}: { oidc?: Reply | Reply[] | Error; sts?: Reply | Reply[] | Error; impersonation?: Reply | Reply[] | Error } = {}) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const queues = new Map<string, (Reply | Error)[]>();
  const next = (key: string, reply: Reply | Reply[] | Error | undefined, fallback: Reply): Reply | Error => {
    if (!Array.isArray(reply)) return reply ?? fallback;
    if (!queues.has(key)) queues.set(key, [...reply]);
    const queue = queues.get(key)!;
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const reply = url.startsWith('https://pipelines.')
      ? next('oidc', oidc, { status: 200, body: { value: 'github-jwt' } })
      : url.startsWith('https://sts.')
        ? next('sts', sts, { status: 200, body: { access_token: 'federated-token' } })
        : next('impersonation', impersonation, {
            status: 200,
            body: { accessToken: 'sa-token', expireTime: '2026-10-19T00:00:00Z' },
          });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};

/** Runs `verifyCredentials` with retry delays on fake timers. */
const verify = async (fetch: typeof globalThis.fetch, signal?: AbortSignal) => {
  const pending = verifyCredentials(config(), { fetch, signal }).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  return pending;
};

describe('verifyCredentials', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exchanges the GitHub token and impersonates the service account', async () => {
    const { fetch, requests } = backend();
    await verifyCredentials(config(), { fetch });
    expect(requests.map((r) => r.url)).toEqual([
      config().credential_source.url,
      'https://sts.googleapis.com/v1/token',
      config().service_account_impersonation_url,
    ]);
    expect(requests[0]!.init.headers).toEqual({ Authorization: 'Bearer request-token' });
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: `//iam.googleapis.com/${PROVIDER}`,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken: 'github-jwt',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    });
    expect(requests[2]!.init.headers).toMatchObject({ authorization: 'Bearer federated-token' });
  });

  const failsWith = async (replies: Parameters<typeof backend>[0], expected: object) => {
    const { fetch } = backend(replies);
    const error = await verify(fetch);
    expect(error).toMatchObject({ code: 'VERIFY_FAILED', ...expected });
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toMatch(
      /github-jwt|federated-token|request-token/,
    );
  };

  it('explains a missing OIDC token', async () => {
    await failsWith(
      { oidc: { status: 403, body: {} } },
      { details: { stage: 'oidc', status: 403 }, fix: expect.stringContaining('id-token: write') },
    );
  });

  it('maps STS errors to fixes', async () => {
    await failsWith(
      {
        sts: {
          status: 400,
          body: {
            error: 'unauthorized_client',
            error_description: 'The given credential is rejected by the attribute condition.',
          },
        },
      },
      {
        message: "The provider's attribute condition doesn't allow this repository.",
        fix: expect.stringContaining('setup'),
      },
    );
    await failsWith(
      {
        sts: {
          status: 400,
          body: {
            error: 'invalid_target',
            error_description: 'The target service indicated by the "audience" parameters is invalid.',
          },
        },
      },
      { message: "The workload identity pool or provider doesn't exist or is disabled." },
    );
    await failsWith(
      {
        sts: {
          status: 400,
          body: {
            error: 'invalid_request',
            error_description: 'The size of mapped attribute google.subject exceeds the 127 bytes limit.',
          },
        },
      },
      {
        message: expect.stringContaining('127-byte google.subject limit'),
        fix: expect.stringContaining('gh.oidc-sub'),
      },
    );
    await failsWith(
      { sts: { status: 500, body: 'oops' } },
      { message: 'Google STS rejected the GitHub token (unknown_error).', details: { stage: 'sts', status: 500 } },
    );
  });

  it('maps impersonation errors to fixes', async () => {
    await failsWith(
      {
        impersonation: {
          status: 403,
          body: { error: { message: "Permission 'iam.serviceAccounts.getAccessToken' denied on resource" } },
        },
      },
      { message: `This repository can't act as ${SA}; it needs roles/iam.workloadIdentityUser.` },
    );
    await failsWith(
      {
        impersonation: {
          status: 403,
          body: {
            error: {
              message: 'IAM Service Account Credentials API has not been used in project 123 before or it is disabled.',
            },
          },
        },
      },
      { message: expect.stringContaining('iamcredentials.googleapis.com') },
    );
    await failsWith({ impersonation: { status: 404, body: {} } }, { message: `Service account ${SA} doesn't exist.` });
    await failsWith(
      { impersonation: { status: 500, body: { error: { message: 'backend' } } } },
      { message: `Couldn't get an access token for ${SA} (500: backend).` },
    );
  });

  it('gives each request a timeout that the caller can also abort', async () => {
    const controller = new AbortController();
    const { fetch, requests } = backend();
    expect(await verify(fetch, controller.signal)).toBeUndefined();
    expect(requests).toHaveLength(3);
    for (const { init } of requests) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal).not.toBe(controller.signal);
    }
    controller.abort();
    expect(requests.every((r) => r.init.signal!.aborted)).toBe(true);
  });

  it('retries network errors, timeouts, 429, and 5xx twice', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { fetch, requests } = backend({
      oidc: [new TypeError('fetch failed') as unknown as Reply, { status: 200, body: { value: 'github-jwt' } }],
      sts: [{ status: 503, body: {} }, timeout as unknown as Reply, { status: 200, body: { access_token: 'x' } }],
      impersonation: [
        { status: 429, body: {} },
        { status: 200, body: { accessToken: 'sa-token' } },
      ],
    });
    expect(await verify(fetch)).toBeUndefined();
    expect(requests.map((r) => new URL(r.url).host)).toEqual([
      'pipelines.actions.githubusercontent.com',
      'pipelines.actions.githubusercontent.com',
      'sts.googleapis.com',
      'sts.googleapis.com',
      'sts.googleapis.com',
      'iamcredentials.googleapis.com',
      'iamcredentials.googleapis.com',
    ]);
  });

  it('does not retry other answers', async () => {
    const { fetch, requests } = backend({ impersonation: { status: 403, body: {} } });
    await verify(fetch);
    expect(requests).toHaveLength(3);
  });

  it('reports the stage when retries run out', async () => {
    const { fetch, requests } = backend({ sts: new TypeError('fetch failed') });
    const error = await verify(fetch);
    expect(error).toMatchObject({
      code: 'VERIFY_FAILED',
      message: "Couldn't reach Google STS (fetch failed).",
      fix: 'Re-run the job.',
      details: { stage: 'sts', status: 0 },
    });
    expect(requests).toHaveLength(4);

    const busy = backend({ sts: { status: 503, body: {} } });
    expect(await verify(busy.fetch)).toMatchObject({ details: { stage: 'sts', status: 503 } });
    expect(busy.requests).toHaveLength(4);
  });

  it('stops retrying when aborted', async () => {
    const controller = new AbortController();
    const { fetch, requests } = backend({ sts: { status: 503, body: {} } });
    const pending = verifyCredentials(config(), { fetch, signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(2);
  });
});
