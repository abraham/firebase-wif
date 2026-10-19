import { describe, expect, it } from 'vitest';
import { createCredentialsConfig, verifyCredentials, type ExternalAccountConfig } from '../src/credentials.js';

const PROVIDER = 'projects/123/locations/global/workloadIdentityPools/github/providers/github-42';
const SA = 'github-42@demo-project.iam.gserviceaccount.com';
const REQUEST_URL = 'https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0';

const config = (audience?: string) =>
  createCredentialsConfig({ provider: PROVIDER, serviceAccount: SA, audience, requestUrl: REQUEST_URL, requestToken: 'request-token' });

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
      createCredentialsConfig({ provider: PROVIDER, serviceAccount: 'nope', requestUrl: REQUEST_URL, requestToken: 't' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_NAME' }));
  });
});

type Reply = { status: number; body: unknown };

/** Fakes GitHub's token endpoint, STS, and IAM Credentials; records each request. */
const backend = ({ oidc, sts, impersonation }: { oidc?: Reply; sts?: Reply; impersonation?: Reply } = {}) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const reply = url.startsWith('https://pipelines.')
      ? (oidc ?? { status: 200, body: { value: 'github-jwt' } })
      : url.startsWith('https://sts.')
        ? (sts ?? { status: 200, body: { access_token: 'federated-token' } })
        : (impersonation ?? { status: 200, body: { accessToken: 'sa-token', expireTime: '2026-10-19T00:00:00Z' } });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};

describe('verifyCredentials', () => {
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
    const error = await verifyCredentials(config(), { fetch }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'VERIFY_FAILED', ...expected });
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toMatch(/github-jwt|federated-token|request-token/);
  };

  it('explains a missing OIDC token', async () => {
    await failsWith({ oidc: { status: 403, body: {} } }, { details: { stage: 'oidc', status: 403 }, fix: expect.stringContaining('id-token: write') });
  });

  it('maps STS errors to fixes', async () => {
    await failsWith(
      { sts: { status: 400, body: { error: 'unauthorized_client', error_description: 'The given credential is rejected by the attribute condition.' } } },
      { message: "The provider's attribute condition doesn't allow this repository.", fix: expect.stringContaining('setup') },
    );
    await failsWith(
      { sts: { status: 400, body: { error: 'invalid_target', error_description: 'The target service indicated by the "audience" parameters is invalid.' } } },
      { message: "The workload identity pool or provider doesn't exist or is disabled." },
    );
    await failsWith(
      { sts: { status: 400, body: { error: 'invalid_request', error_description: 'The size of mapped attribute google.subject exceeds the 127 bytes limit.' } } },
      { message: expect.stringContaining('127-byte google.subject limit'), fix: expect.stringContaining('gh.oidc-sub') },
    );
    await failsWith({ sts: { status: 500, body: 'oops' } }, { message: 'Google STS rejected the GitHub token (unknown_error).', details: { stage: 'sts', status: 500 } });
  });

  it('maps impersonation errors to fixes', async () => {
    await failsWith(
      { impersonation: { status: 403, body: { error: { message: "Permission 'iam.serviceAccounts.getAccessToken' denied on resource" } } } },
      { message: `This repository can't act as ${SA}; it needs roles/iam.workloadIdentityUser.` },
    );
    await failsWith(
      {
        impersonation: {
          status: 403,
          body: { error: { message: 'IAM Service Account Credentials API has not been used in project 123 before or it is disabled.' } },
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

  it('passes the abort signal to every request', async () => {
    const controller = new AbortController();
    const { fetch, requests } = backend();
    await verifyCredentials(config() as ExternalAccountConfig, { fetch, signal: controller.signal });
    expect(requests.every((r) => r.init.signal === controller.signal)).toBe(true);
  });
});
