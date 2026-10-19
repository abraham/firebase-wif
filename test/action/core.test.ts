import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCore, isEntryPoint } from '../../src/action/core.js';

const setup = async (env: NodeJS.ProcessEnv = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'firebase-wif-core-'));
  const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_ENV: join(dir, 'env'), GITHUB_STATE: join(dir, 'state') };
  const fullEnv: NodeJS.ProcessEnv = { ...files, ...env };
  let stdout = '';
  const core = createCore({ env: fullEnv, stdout: (text) => (stdout += text) });
  const read = async (name: keyof typeof files) => readFile(files[name], 'utf8').catch(() => '');
  return { core, env: fullEnv, read, stdout: () => stdout };
};

describe('createCore', () => {
  it('reads inputs like @actions/core', async () => {
    const { core } = await setup({
      INPUT_SERVICE_ACCOUNT: '  sa@x.iam.gserviceaccount.com\n',
      INPUT_VERIFY: 'False',
      INPUT_BAD: 'yes',
    });
    expect(core.getInput('service_account')).toBe('sa@x.iam.gserviceaccount.com');
    expect(core.getInput('missing')).toBe('');
    expect(() => core.getInput('missing', { required: true })).toThrow('Input required and not supplied: missing');
    expect(core.getBooleanInput('verify', true)).toBe(false);
    expect(core.getBooleanInput('missing', true)).toBe(true);
    expect(() => core.getBooleanInput('bad', true)).toThrow('Input bad must be true or false, not "yes".');
  });

  it('writes outputs, environment variables, and state through file commands', async () => {
    const { core, env, read } = await setup();
    core.setOutput('credentials_json', '{"a":\n1}');
    core.exportVariable('GOOGLE_CLOUD_PROJECT', 'demo-project');
    core.saveState('credentials_path', '/tmp/x.json');

    expect(await read('GITHUB_OUTPUT')).toMatch(/^credentials_json<<(ghadelimiter_[\w-]+)\n\{"a":\n1\}\n\1\n$/);
    expect(await read('GITHUB_ENV')).toMatch(/^GOOGLE_CLOUD_PROJECT<<(ghadelimiter_[\w-]+)\ndemo-project\n\1\n$/);
    expect(await read('GITHUB_STATE')).toMatch(/^credentials_path<<(ghadelimiter_[\w-]+)\n\/tmp\/x\.json\n\1\n$/);
    expect(env.GOOGLE_CLOUD_PROJECT).toBe('demo-project');
  });

  it('fails outside GitHub Actions', () => {
    const core = createCore({ env: {}, stdout: () => {} });
    expect(() => core.setOutput('a', 'b')).toThrow('GITHUB_OUTPUT is not set');
  });

  it('masks secrets and prints workflow commands with escaped data', async () => {
    const { core, stdout } = await setup({ STATE_credentials_path: '/tmp/x.json' });
    core.setSecret('a%b\nc');
    core.info('hello');
    core.warning('careful\nnow');
    core.error('broke');
    expect(stdout()).toBe('::add-mask::a%25b%0Ac\nhello\n::warning::careful%0Anow\n::error::broke\n');
    expect(core.getState('credentials_path')).toBe('/tmp/x.json');
    expect(core.getState('missing')).toBe('');
  });
});

describe('isEntryPoint', () => {
  it('compares the module URL with the script Node started', () => {
    expect(isEntryPoint(pathToFileURL('/a/main.js').href, '/a/main.js')).toBe(true);
    expect(isEntryPoint(pathToFileURL('/a/main.js').href, '/a/post.js')).toBe(false);
    expect(isEntryPoint(import.meta.url)).toBe(false);
  });
});
