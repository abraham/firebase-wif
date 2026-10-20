// src/action/main.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

// src/core/errors.ts
var FirebaseWifError = class extends Error {
  code;
  fix;
  details;
  // Errors raised mid-apply get their `ApplyFailure` details when the engine wraps them.
  constructor(code, message, options = {}) {
    super(message);
    this.name = "FirebaseWifError";
    this.code = code;
    this.fix = options.fix;
    this.details = options.details;
  }
};

// src/core/naming.ts
var ANY_SA_EMAIL = /^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/;
var PROVIDER_NAME = /^projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]{4,32})\/providers\/([a-z0-9-]{4,32})$/;
var invalid = (what, value, rule) => {
  throw new FirebaseWifError("INVALID_NAME", `Invalid ${what} "${value}": ${rule}.`);
};
var validateServiceAccountEmail = (value) => ANY_SA_EMAIL.test(value) ? value : invalid("service account", value, "expected an email ending in .gserviceaccount.com");
var parseProviderName = (name) => {
  const match = PROVIDER_NAME.exec(name);
  return match ? { projectNumber: match[1], pool: match[2], provider: match[3] } : void 0;
};

// src/credentials.ts
var STS_URL = "https://sts.googleapis.com/v1/token";
var CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
var SETUP_FIX = "Run npx @abraham/firebase-wif setup locally.";
var STATUS_FIX = "Run npx @abraham/firebase-wif status locally to see what is wrong.";
var createCredentialsConfig = ({
  provider,
  serviceAccount,
  audience,
  requestUrl,
  requestToken
}) => {
  if (!parseProviderName(provider)) {
    throw new FirebaseWifError("INVALID_NAME", `Invalid workload identity provider "${provider}".`, {
      fix: "Expected projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>."
    });
  }
  validateServiceAccountEmail(serviceAccount);
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience || `https://iam.googleapis.com/${provider}`);
  return {
    type: "external_account",
    audience: `//iam.googleapis.com/${provider}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: STS_URL,
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    credential_source: {
      url: url.toString(),
      headers: { Authorization: `Bearer ${requestToken}` },
      format: { type: "json", subject_token_field_name: "value" }
    }
  };
};
var readBody = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};
var failure = (stage, status) => (message, fix) => new FirebaseWifError("VERIFY_FAILED", message, { fix, details: { stage, status } });
var stsError = (status, body) => {
  const fail = failure("sts", status);
  const code = typeof body.error === "string" ? body.error : "unknown_error";
  const description = (typeof body.error_description === "string" ? body.error_description : "").slice(0, 300);
  if (/google\.subject/i.test(description)) {
    return fail(
      `The job's OIDC sub claim is longer than the 127-byte google.subject limit (${description}).`,
      "Use shorter branch or environment names, or fewer sub claims. Run npx @abraham/firebase-wif status and see gh.oidc-sub."
    );
  }
  if ((code === "invalid_grant" || code === "unauthorized_client") && /attribute condition/i.test(description)) {
    return fail("The provider's attribute condition doesn't allow this repository.", SETUP_FIX);
  }
  if (code === "invalid_target") {
    return fail(
      "The workload identity pool or provider doesn't exist or is disabled.",
      `Check workload_identity_provider. ${STATUS_FIX}`
    );
  }
  return fail(`Google STS rejected the GitHub token (${code}${description ? `: ${description}` : ""}).`, STATUS_FIX);
};
var impersonationError = (status, body, serviceAccount) => {
  const fail = failure("impersonation", status);
  const error = body.error;
  const message = (error?.message ?? "").slice(0, 300);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
    return fail("The IAM Service Account Credentials API (iamcredentials.googleapis.com) is not enabled.", SETUP_FIX);
  }
  if (status === 403) {
    return fail(`This repository can't act as ${serviceAccount}; it needs roles/iam.workloadIdentityUser.`, SETUP_FIX);
  }
  if (status === 404) {
    return fail(`Service account ${serviceAccount} doesn't exist.`, `Check service_account. ${SETUP_FIX}`);
  }
  return fail(
    `Couldn't get an access token for ${serviceAccount} (${status}${message ? `: ${message}` : ""}).`,
    STATUS_FIX
  );
};
var verifyCredentials = async (config, { signal, fetch = globalThis.fetch } = {}) => {
  const oidc = await fetch(config.credential_source.url, { headers: config.credential_source.headers, signal });
  const oidcBody = await readBody(oidc);
  if (!oidc.ok || typeof oidcBody.value !== "string") {
    throw failure("oidc", oidc.status)(
      `Couldn't get an OIDC token from GitHub (${oidc.status}).`,
      "Add `permissions: id-token: write` to the job."
    );
  }
  const sts = await fetch(config.token_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: config.audience,
      scope: CLOUD_PLATFORM_SCOPE,
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectToken: oidcBody.value,
      subjectTokenType: config.subject_token_type
    }),
    signal
  });
  const stsBody = await readBody(sts);
  if (!sts.ok || typeof stsBody.access_token !== "string") throw stsError(sts.status, stsBody);
  const serviceAccount = /serviceAccounts\/([^:]+):generateAccessToken$/.exec(config.service_account_impersonation_url)?.[1] ?? "the service account";
  const impersonation = await fetch(config.service_account_impersonation_url, {
    method: "POST",
    headers: { authorization: `Bearer ${stsBody.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE] }),
    signal
  });
  const impersonationBody = await readBody(impersonation);
  if (!impersonation.ok || typeof impersonationBody.accessToken !== "string") {
    throw impersonationError(impersonation.status, impersonationBody, serviceAccount);
  }
};

// src/action/core.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";
import { pathToFileURL } from "node:url";
var escapeData = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var CREDENTIALS_PATH_STATE = "credentials_path";
var createCore = ({
  env = process.env,
  stdout = (text) => void process.stdout.write(text)
} = {}) => {
  const fileCommand = (variable, name, value) => {
    const file = env[variable];
    if (!file) throw new Error(`${variable} is not set; this must run inside GitHub Actions.`);
    const delimiter = `ghadelimiter_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, "utf8");
  };
  const getInput = (name, { required = false } = {}) => {
    const value = (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
    if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
    return value;
  };
  return {
    getInput,
    getBooleanInput(name, fallback) {
      const value = getInput(name);
      if (!value) return fallback;
      if (/^true$/i.test(value)) return true;
      if (/^false$/i.test(value)) return false;
      throw new Error(`Input ${name} must be true or false, not "${value}".`);
    },
    setOutput: (name, value) => fileCommand("GITHUB_OUTPUT", name, value),
    exportVariable(name, value) {
      env[name] = value;
      fileCommand("GITHUB_ENV", name, value);
    },
    setSecret: (value) => stdout(`::add-mask::${escapeData(value)}${EOL}`),
    saveState: (name, value) => fileCommand("GITHUB_STATE", name, value),
    getState: (name) => env[`STATE_${name}`] ?? "",
    info: (message) => stdout(`${message}${EOL}`),
    warning: (message) => stdout(`::warning::${escapeData(message)}${EOL}`),
    error: (message) => stdout(`::error::${escapeData(message)}${EOL}`)
  };
};
var isEntryPoint = (moduleUrl, argv1 = process.argv[1]) => argv1 !== void 0 && pathToFileURL(argv1).href === moduleUrl;

// src/action/main.ts
var MISSING_OIDC_TOKEN = "Missing OIDC token. Add `permissions: id-token: write` to the job. Pull requests from forks can't get OIDC tokens; guard the job with `if: github.event.pull_request.head.repo.full_name == github.repository`.";
var isInside = (child, parent) => {
  const path = relative(parent, child);
  return path === "" || !path.startsWith("..") && !isAbsolute(path);
};
var defaultProject = async (dir) => {
  try {
    const firebaserc = JSON.parse(await readFile(join(dir, ".firebaserc"), "utf8"));
    return typeof firebaserc.projects?.default === "string" ? firebaserc.projects.default : void 0;
  } catch {
    return void 0;
  }
};
var runMain = async ({
  env = process.env,
  stdout,
  fetch,
  cwd = process.cwd(),
  randomId = randomUUID2
} = {}) => {
  const core = createCore({ env, stdout });
  try {
    if ((env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "") !== "https://github.com") {
      throw new Error("Only github.com is supported; GitHub Enterprise Server is not.");
    }
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) throw new Error(MISSING_OIDC_TOKEN);
    core.setSecret(requestToken);
    const provider = core.getInput("workload_identity_provider", { required: true });
    const serviceAccount = core.getInput("service_account", { required: true });
    const verify = core.getBooleanInput("verify", true);
    const exportEnvironment = core.getBooleanInput("export_environment", true);
    const config = createCredentialsConfig({
      provider,
      serviceAccount,
      audience: core.getInput("audience") || void 0,
      requestUrl,
      requestToken
    });
    const json = JSON.stringify(config);
    core.setSecret(json);
    const workspace = resolve(cwd, env.GITHUB_WORKSPACE ?? ".");
    const fromFirebaserc = await defaultProject(resolve(workspace, core.getInput("working_directory") || "."));
    const projectId = core.getInput("project_id") || fromFirebaserc || parseProviderName(provider).projectNumber;
    if (!env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is not set; this must run inside GitHub Actions.");
    const temp = resolve(cwd, env.RUNNER_TEMP);
    if (isInside(temp, workspace)) {
      throw new Error(
        "RUNNER_TEMP is inside GITHUB_WORKSPACE, so the credentials file could end up in a deploy, artifact, or commit."
      );
    }
    const path = join(temp, `firebase-wif-${randomId()}.json`);
    await writeFile(path, json, { mode: 384, flag: "wx" });
    core.saveState(CREDENTIALS_PATH_STATE, path);
    core.info(`Wrote credentials for ${serviceAccount} to ${path}.`);
    if (verify) {
      await verifyCredentials(config, { fetch });
      core.info(`Verified that this job can act as ${serviceAccount}.`);
    }
    if (exportEnvironment) {
      for (const name of [
        "GOOGLE_APPLICATION_CREDENTIALS",
        "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
        "GOOGLE_GHA_CREDS_PATH"
      ]) {
        core.exportVariable(name, path);
      }
      for (const name of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"])
        core.exportVariable(name, projectId);
    }
    core.setOutput("credentials_file_path", path);
    core.setOutput("credentials_json", json);
    core.setOutput("project_id", projectId);
    core.setOutput("service_account", serviceAccount);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fix = error instanceof FirebaseWifError && error.fix ? ` ${error.fix}` : "";
    core.error(`${message}${fix}`);
    return 1;
  }
};
if (isEntryPoint(import.meta.url)) process.exitCode = await runMain();
export {
  runMain
};
