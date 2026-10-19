import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runMain } from '../../src/action/main.js';

const PROVIDER = 'projects/123456789012/locations/global/workloadIdentityPools/github/providers/github-42';
const SA = 'github-42@demo-project.iam.gserviceaccount.com';
const REQUEST_TOKEN = 'SENTINEL-request-token';

const runner = async (inputs: Record<string, string> = {}, extraEnv: NodeJS.ProcessEnv = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'firebase-wif-action-'));
  const workspace = join(root, 'workspace');
  const temp = join(root, 'temp');
  await mkdir(workspace);
  await mkdir(temp);
  const env: NodeJS.ProcessEnv = {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temp,
    GITHUB_OUTPUT: join(root, 'output'),
    GITHUB_ENV: join(root, 'env'),
    GITHUB_STATE: join(root, 'state'),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
    INPUT_WORKLOAD_IDENTITY_PROVIDER: PROVIDER,
    INPUT_SERVICE_ACCOUNT: SA,
    INPUT_WORKING_DIRECTORY: '.',
    INPUT_VERIFY: 'true',
    INPUT_EXPORT_ENVIRONMENT: 'true',
    ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
    ...extraEnv,
  };
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://pipelines.')) return new Response(JSON.stringify({ value: 'SENTINEL-jwt' }));
    if (url.startsWith('https://sts.')) return new Response(JSON.stringify({ access_token: 'SENTINEL-federated' }));
    const status = Number(extraEnv.FAKE_IMPERSONATION_STATUS || 200);
    return new Response(JSON.stringify(status === 200 ? { accessToken: 'SENTINEL-sa' } : { error: { message: 'denied' } }), { status });
  }) as typeof globalThis.fetch;
  let stdout = '';
  const read = (name: 'output' | 'env' | 'state') => readFile(join(root, name), 'utf8').catch(() => '');
  const run = async () => runMain({ env, fetch, stdout: (text) => (stdout += text), cwd: workspace, randomId: () => 'abc' });
  return { root, workspace, temp, env, urls, read, run, stdout: () => stdout };
};

/** Parses `name<<delimiter` file commands into a map. */
const commands = (text: string) =>
  Object.fromEntries([...text.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map((match) => [match[1], match[3]]));

describe('runMain', () => {
  it('writes masked credentials outside the workspace and exports them', async () => {
    const action = await runner();
    await writeFile(join(action.workspace, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    expect(await action.run()).toBe(0);

    const path = join(action.temp, 'firebase-wif-abc.json');
    const json = await readFile(path, 'utf8');
    expect(JSON.parse(json)).toMatchObject({ type: 'external_account', audience: `//iam.googleapis.com/${PROVIDER}` });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(action.urls).toHaveLength(3);

    expect(commands(await action.read('output'))).toEqual({
      credentials_file_path: path,
      credentials_json: json,
      project_id: 'demo-project',
      service_account: SA,
    });
    expect(commands(await action.read('env'))).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: path,
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: path,
      GOOGLE_GHA_CREDS_PATH: path,
      GOOGLE_CLOUD_PROJECT: 'demo-project',
      GCLOUD_PROJECT: 'demo-project',
      CLOUDSDK_CORE_PROJECT: 'demo-project',
    });
    expect(commands(await action.read('state'))).toEqual({ credentials_path: path });

    const lines = action.stdout().split('\n');
    // The runner unescapes %25 in workflow commands, so the URL-encoded audience still masks correctly.
    expect(lines.slice(0, 2)).toEqual([`::add-mask::${REQUEST_TOKEN}`, `::add-mask::${json.replace(/%/g, '%25')}`]);
    expect(lines.slice(2).join('\n')).not.toContain('SENTINEL');
  });

  it('prefers the project_id input and falls back to the project number', async () => {
    const explicit = await runner({ project_id: 'other-project', verify: 'false' });
    await explicit.run();
    expect(commands(await explicit.read('output')).project_id).toBe('other-project');

    const fallback = await runner({ verify: 'false' });
    await fallback.run();
    expect(commands(await fallback.read('output')).project_id).toBe('123456789012');
  });

  it('reads .firebaserc from working_directory', async () => {
    const action = await runner({ working_directory: 'site', verify: 'false' });
    await mkdir(join(action.workspace, 'site'));
    await writeFile(join(action.workspace, 'site', '.firebaserc'), JSON.stringify({ projects: { default: 'site-project' } }));
    await action.run();
    expect(commands(await action.read('output')).project_id).toBe('site-project');
  });

  it('skips verification and exports when asked', async () => {
    const action = await runner({ verify: 'false', export_environment: 'false' });
    expect(await action.run()).toBe(0);
    expect(action.urls).toEqual([]);
    expect(await action.read('env')).toBe('');
  });

  it('fails with a fix when verification fails, leaving cleanup to post', async () => {
    const action = await runner({}, { FAKE_IMPERSONATION_STATUS: '403' });
    expect(await action.run()).toBe(1);
    expect(action.stdout()).toContain(
      `::error::This repository can't act as ${SA}; it needs roles/iam.workloadIdentityUser. Run npx @abraham/firebase-wif setup locally.`,
    );
    expect(await action.read('output')).toBe('');
    expect(commands(await action.read('state')).credentials_path).toBe(join(action.temp, 'firebase-wif-abc.json'));
  });

  it.each([
    [{ GITHUB_SERVER_URL: 'https://github.example.com' }, 'Only github.com is supported; GitHub Enterprise Server is not.'],
    [{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, 'Missing OIDC token. Add `permissions: id-token: write` to the job.'],
    [{ INPUT_SERVICE_ACCOUNT: '' }, 'Input required and not supplied: service_account'],
    [{ INPUT_WORKLOAD_IDENTITY_PROVIDER: 'github' }, 'Invalid workload identity provider "github".'],
    [{ INPUT_VERIFY: 'maybe' }, 'Input verify must be true or false'],
    [{ RUNNER_TEMP: '' }, 'RUNNER_TEMP is not set'],
  ])('fails before writing anything for %j', async (env, message) => {
    const action = await runner({}, env);
    expect(await action.run()).toBe(1);
    expect(action.stdout()).toContain(`::error::${message}`);
    expect(await readdir(action.temp)).toEqual([]);
  });

  it('refuses a RUNNER_TEMP inside the workspace', async () => {
    const action = await runner();
    action.env.RUNNER_TEMP = join(action.workspace, 'tmp');
    expect(await action.run()).toBe(1);
    expect(action.stdout()).toContain('::error::RUNNER_TEMP is inside GITHUB_WORKSPACE');
  });
});

describe('dist/action/main.js', () => {
  it('runs as the bundled entry point', async () => {
    const action = await runner({ verify: 'false' });
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../dist/action/main.js')], {
      env: action.env,
      cwd: action.workspace,
    });
    expect(stdout).toContain(`::add-mask::${REQUEST_TOKEN}`);
    expect(commands(await action.read('output')).service_account).toBe(SA);
  });
});
