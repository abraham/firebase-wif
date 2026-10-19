import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { FirebaseWifError } from '../core/errors.js';
import { parseProviderName } from '../core/naming.js';
import { createCredentialsConfig, verifyCredentials } from '../credentials.js';
import { createCore, CREDENTIALS_PATH_STATE, isEntryPoint } from './core.js';

const MISSING_OIDC_TOKEN =
  "Missing OIDC token. Add `permissions: id-token: write` to the job. Pull requests from forks can't get OIDC tokens; " +
  'guard the job with `if: github.event.pull_request.head.repo.full_name == github.repository`.';

export interface ActionDeps {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  fetch?: typeof globalThis.fetch;
  cwd?: string;
  randomId?: () => string;
}

const isInside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const defaultProject = async (dir: string): Promise<string | undefined> => {
  try {
    const firebaserc = JSON.parse(await readFile(join(dir, '.firebaserc'), 'utf8')) as {
      projects?: { default?: unknown };
    };
    return typeof firebaserc.projects?.default === 'string' ? firebaserc.projects.default : undefined;
  } catch {
    return undefined;
  }
};

/** Writes Google credentials for this job and exports them for later steps. Returns the exit code. */
export const runMain = async ({
  env = process.env,
  stdout,
  fetch,
  cwd = process.cwd(),
  randomId = randomUUID,
}: ActionDeps = {}): Promise<number> => {
  const core = createCore({ env, stdout });
  try {
    if ((env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/$/, '') !== 'https://github.com') {
      throw new Error('Only github.com is supported; GitHub Enterprise Server is not.');
    }
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) throw new Error(MISSING_OIDC_TOKEN);
    core.setSecret(requestToken);

    const provider = core.getInput('workload_identity_provider', { required: true });
    const serviceAccount = core.getInput('service_account', { required: true });
    const verify = core.getBooleanInput('verify', true);
    const exportEnvironment = core.getBooleanInput('export_environment', true);
    const config = createCredentialsConfig({
      provider,
      serviceAccount,
      audience: core.getInput('audience') || undefined,
      requestUrl,
      requestToken,
    });
    const json = JSON.stringify(config);
    core.setSecret(json);

    const workspace = resolve(cwd, env.GITHUB_WORKSPACE ?? '.');
    const fromFirebaserc = await defaultProject(resolve(workspace, core.getInput('working_directory') || '.'));
    const projectId = core.getInput('project_id') || fromFirebaserc || parseProviderName(provider)!.projectNumber;

    if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is not set; this must run inside GitHub Actions.');
    const temp = resolve(cwd, env.RUNNER_TEMP);
    if (isInside(temp, workspace)) {
      throw new Error(
        'RUNNER_TEMP is inside GITHUB_WORKSPACE, so the credentials file could end up in a deploy, artifact, or commit.',
      );
    }
    const path = join(temp, `firebase-wif-${randomId()}.json`);
    await writeFile(path, json, { mode: 0o600, flag: 'wx' });
    core.saveState(CREDENTIALS_PATH_STATE, path);
    core.info(`Wrote credentials for ${serviceAccount} to ${path}.`);

    if (verify) {
      await verifyCredentials(config, { fetch });
      core.info(`Verified that this job can act as ${serviceAccount}.`);
    }

    if (exportEnvironment) {
      for (const name of [
        'GOOGLE_APPLICATION_CREDENTIALS',
        'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
        'GOOGLE_GHA_CREDS_PATH',
      ]) {
        core.exportVariable(name, path);
      }
      for (const name of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT'])
        core.exportVariable(name, projectId);
    }
    core.setOutput('credentials_file_path', path);
    core.setOutput('credentials_json', json);
    core.setOutput('project_id', projectId);
    core.setOutput('service_account', serviceAccount);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fix = error instanceof FirebaseWifError && error.fix ? ` ${error.fix}` : '';
    core.error(`${message}${fix}`);
    return 1;
  }
};

if (isEntryPoint(import.meta.url)) process.exitCode = await runMain();
