import { FirebaseWifError } from './core/errors.js';
import { parseProviderName, validateServiceAccountEmail } from './core/naming.js';

export { FirebaseWifError, isFirebaseWifError } from './core/errors.js';
export { parseProviderName } from './core/naming.js';

const STS_URL = 'https://sts.googleapis.com/v1/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const SETUP_FIX = 'Run npx @abraham/firebase-wif setup locally.';
const STATUS_FIX = 'Run npx @abraham/firebase-wif status locally to see what is wrong.';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1000, 2000];

/** The Google `external_account` credential file format, as written by google-github-actions/auth. */
export interface ExternalAccountConfig {
  type: 'external_account';
  audience: string;
  subject_token_type: 'urn:ietf:params:oauth:token-type:jwt';
  token_url: string;
  service_account_impersonation_url: string;
  credential_source: {
    url: string;
    headers: { Authorization: string };
    format: { type: 'json'; subject_token_field_name: 'value' };
  };
}

export interface CredentialsInput {
  /** Full provider resource name, `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<id>`. */
  provider: string;
  serviceAccount: string;
  /** Audience for the GitHub OIDC token; defaults to `https://iam.googleapis.com/<provider>`. */
  audience?: string | undefined;
  /** `ACTIONS_ID_TOKEN_REQUEST_URL` */
  requestUrl: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_TOKEN` */
  requestToken: string;
}

/** Builds an `external_account` config that exchanges the job's GitHub OIDC token for Google credentials. */
export const createCredentialsConfig = ({
  provider,
  serviceAccount,
  audience,
  requestUrl,
  requestToken,
}: CredentialsInput): ExternalAccountConfig => {
  if (!parseProviderName(provider)) {
    throw new FirebaseWifError('INVALID_NAME', `Invalid workload identity provider "${provider}".`, {
      fix: 'Expected projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>.',
    });
  }
  validateServiceAccountEmail(serviceAccount);
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience || `https://iam.googleapis.com/${provider}`);
  return {
    type: 'external_account',
    audience: `//iam.googleapis.com/${provider}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: STS_URL,
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    credential_source: {
      url: url.toString(),
      headers: { Authorization: `Bearer ${requestToken}` },
      format: { type: 'json', subject_token_field_name: 'value' },
    },
  };
};

const readBody = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

type Stage = 'oidc' | 'sts' | 'impersonation';

const failure = (stage: Stage, status: number) => (message: string, fix: string) =>
  new FirebaseWifError('VERIFY_FAILED', message, { fix, details: { stage, status } });

const STAGE_NAMES: Record<Stage, string> = {
  oidc: "GitHub's OIDC token endpoint",
  sts: 'Google STS',
  impersonation: 'the IAM Service Account Credentials API',
};

const wait = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Fetches with a per-request timeout, retrying network errors, timeouts, 429, and 5xx. */
const send = async (
  fetch: typeof globalThis.fetch,
  stage: Stage,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const last = attempt === RETRY_DELAYS_MS.length;
    try {
      const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (last || (response.status !== 429 && response.status < 500)) return response;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (last) {
        // Only the error's own message: a cause could carry request details.
        const reason = error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
        throw failure(stage, 0)(`Couldn't reach ${STAGE_NAMES[stage]} (${reason}).`, 'Re-run the job.');
      }
    }
    await wait(RETRY_DELAYS_MS[attempt]!, signal);
  }
};

const stsError = (status: number, body: Record<string, unknown>) => {
  const fail = failure('sts', status);
  const code = typeof body.error === 'string' ? body.error : 'unknown_error';
  const description = (typeof body.error_description === 'string' ? body.error_description : '').slice(0, 300);
  if (/google\.subject/i.test(description)) {
    return fail(
      `The job's OIDC sub claim is longer than the 127-byte google.subject limit (${description}).`,
      'Use shorter branch or environment names, or fewer sub claims. Run npx @abraham/firebase-wif status and see gh.oidc-sub.',
    );
  }
  if ((code === 'invalid_grant' || code === 'unauthorized_client') && /attribute condition/i.test(description)) {
    return fail("The provider's attribute condition doesn't allow this repository.", SETUP_FIX);
  }
  if (code === 'invalid_target') {
    return fail(
      "The workload identity pool or provider doesn't exist or is disabled.",
      `Check workload_identity_provider. ${STATUS_FIX}`,
    );
  }
  return fail(`Google STS rejected the GitHub token (${code}${description ? `: ${description}` : ''}).`, STATUS_FIX);
};

const impersonationError = (status: number, body: Record<string, unknown>, serviceAccount: string) => {
  const fail = failure('impersonation', status);
  const error = body.error as { message?: string } | undefined;
  const message = (error?.message ?? '').slice(0, 300);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
    return fail('The IAM Service Account Credentials API (iamcredentials.googleapis.com) is not enabled.', SETUP_FIX);
  }
  if (status === 403) {
    return fail(`This repository can't act as ${serviceAccount}; it needs roles/iam.workloadIdentityUser.`, SETUP_FIX);
  }
  if (status === 404) {
    return fail(`Service account ${serviceAccount} doesn't exist.`, `Check service_account. ${SETUP_FIX}`);
  }
  return fail(
    `Couldn't get an access token for ${serviceAccount} (${status}${message ? `: ${message}` : ''}).`,
    STATUS_FIX,
  );
};

/**
 * Does the same exchange Google client libraries will do with `config`: fetch the GitHub OIDC token,
 * exchange it at STS, and impersonate the service account. Throws `VERIFY_FAILED` with a fix.
 */
export const verifyCredentials = async (
  config: ExternalAccountConfig,
  {
    signal,
    fetch = globalThis.fetch,
  }: { signal?: AbortSignal | undefined; fetch?: typeof globalThis.fetch | undefined } = {},
): Promise<void> => {
  const oidc = await send(
    fetch,
    'oidc',
    config.credential_source.url,
    { headers: config.credential_source.headers },
    signal,
  );
  const oidcBody = await readBody(oidc);
  if (!oidc.ok || typeof oidcBody.value !== 'string') {
    throw failure('oidc', oidc.status)(
      `Couldn't get an OIDC token from GitHub (${oidc.status}).`,
      'Add `permissions: id-token: write` to the job.',
    );
  }

  const sts = await send(
    fetch,
    'sts',
    config.token_url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience: config.audience,
        scope: CLOUD_PLATFORM_SCOPE,
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        subjectToken: oidcBody.value,
        subjectTokenType: config.subject_token_type,
      }),
    },
    signal,
  );
  const stsBody = await readBody(sts);
  if (!sts.ok || typeof stsBody.access_token !== 'string') throw stsError(sts.status, stsBody);

  const serviceAccount =
    /serviceAccounts\/([^:]+):generateAccessToken$/.exec(config.service_account_impersonation_url)?.[1] ??
    'the service account';
  const impersonation = await send(
    fetch,
    'impersonation',
    config.service_account_impersonation_url,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${stsBody.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE] }),
    },
    signal,
  );
  const impersonationBody = await readBody(impersonation);
  if (!impersonation.ok || typeof impersonationBody.accessToken !== 'string') {
    throw impersonationError(impersonation.status, impersonationBody, serviceAccount);
  }
};
