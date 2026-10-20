import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, setup, status } from '../src/index.js';
import type { ProgressEvent } from '../src/index.js';
import { createConfiguredFakes } from '../src/testing/index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('library contract', () => {
  it('has no side effects on import', async () => {
    const log = vi.spyOn(console, 'log');
    const write = vi.spyOn(process.stdout, 'write');
    vi.resetModules();
    await import('../src/index.js');
    await import('../src/presets.js');
    await import('../src/gh.js');
    await import('../src/credentials.js');
    await import('../src/testing/index.js');
    expect(log).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('never prints, exits, or reads the environment during status', async () => {
    const fakes = createConfiguredFakes();
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never),
    ];
    const env = process.env;
    const reads: string[] = [];
    process.env = new Proxy(env, {
      get(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key);
      },
    });
    try {
      await status({ ...fakes.options, google: fakes.google, github: fakes.github });
    } finally {
      process.env = env;
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it('never prints, exits, or reads the environment during setup', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.pools[fakes.names.pool];
    fakes.github.state.repos['octo-org/site']!.variables = {};
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never),
    ];
    const env = process.env;
    const reads: string[] = [];
    process.env = new Proxy(env, {
      get(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key);
      },
    });
    let result;
    try {
      result = await setup({ ...fakes.options, google: fakes.google, github: fakes.github, sleep: async () => {} });
    } finally {
      process.env = env;
    }
    expect('applied' in result && result.applied).toHaveLength(3);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it('only reads the filesystem in context resolution', async () => {
    const dir = join(import.meta.dirname, '../src');
    // The Action isn't part of the library; it writes the credentials file by design.
    const files = (await readdir(dir, { recursive: true })).filter(
      (file) => file.endsWith('.ts') && !file.startsWith('action'),
    );
    const readers = [];
    for (const file of files) {
      if (/from 'node:fs/.test(await readFile(join(dir, file), 'utf8'))) readers.push(file);
    }
    expect(readers).toEqual(['core/context.ts']);
  });

  it('stops when the signal aborts', async () => {
    const fakes = createConfiguredFakes();
    const controller = new AbortController();
    let calls = 0;
    const google = {
      request: <T>(method: string, url: string, body?: unknown) => {
        if (++calls === 3) controller.abort();
        return fakes.google.request<T>(method, url, body);
      },
    };
    await expect(
      status({ ...fakes.options, google, github: fakes.github, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBeLessThan(6);
  });

  it('never surfaces tokens in reports, events, or errors', async () => {
    const fakes = createConfiguredFakes();
    const GOOGLE_TOKEN = 'ya29.SENTINEL-google-token';
    const GITHUB_TOKEN = 'ghp_SENTINEL-github-token';
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push(headers.get('authorization') ?? '');
      const target = new URL(url);
      try {
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        const data =
          target.hostname === 'api.github.com'
            ? await fakes.github.request('GET', `${target.pathname}${target.search}`)
            : await fakes.google.request(init.method ?? 'GET', url, body);
        return new Response(JSON.stringify(data), { status: 200 });
      } catch (error) {
        // Echo the token back, as a misbehaving proxy might.
        return new Response(JSON.stringify({ error: { message: `denied` } }), {
          status: (error as HttpError).status ?? 500,
          headers: { 'x-echo': headers.get('authorization') ?? '' },
        });
      }
    });

    fakes.google.state.forbidden = ['/keys'];
    const events: ProgressEvent[] = [];
    const report = await status({
      ...fakes.options,
      google: { accessToken: GOOGLE_TOKEN },
      github: { token: GITHUB_TOKEN },
      onEvent: (event) => events.push(event),
    });

    expect(seen).toContain(`Bearer ${GOOGLE_TOKEN}`);
    expect(seen).toContain(`Bearer ${GITHUB_TOKEN}`);
    const output = JSON.stringify({ report, events });
    expect(output).not.toContain('SENTINEL');

    const failing = await status({
      ...fakes.options,
      projectId: 'missing-project',
      google: { accessToken: GOOGLE_TOKEN },
      github: { token: GITHUB_TOKEN },
    }).catch((error: unknown) => error);
    expect(JSON.stringify({ ...(failing as object), message: (failing as Error).message })).not.toContain('SENTINEL');
  });
});

describe('exports', () => {
  it('exposes the public API', async () => {
    const api = await import('../src/index.js');
    expect(Object.keys(api).sort()).toEqual([
      'CROSS_PROJECT_PERMISSIONS',
      'DEFAULTS',
      'FirebaseWifError',
      'HttpError',
      'SETUP_PERMISSIONS',
      'createGitHubClient',
      'createGoogleClient',
      'defaultGitHubClient',
      'defaultGoogleClient',
      'isFirebaseWifError',
      'parseGitHubRemote',
      'plan',
      'projectAliases',
      'resolveContext',
      'setup',
      'status',
    ]);
  });

  it('exposes the other entry points', async () => {
    const keys = async (entry: Promise<object>) => Object.keys(await entry).sort();
    expect(await keys(import('../src/presets.js'))).toEqual([
      'BASE_APIS',
      'PRESETS',
      'PRESET_NAMES',
      'SERVICE_ACCOUNT_USER_ROLE',
      'apisFor',
      'resolvePresets',
      'rolesFor',
    ]);
    expect(await keys(import('../src/credentials.js'))).toEqual([
      'FirebaseWifError',
      'createCredentialsConfig',
      'isFirebaseWifError',
      'verifyCredentials',
    ]);
    expect(await keys(import('../src/gh.js'))).toEqual(['ghCliClient']);
    expect(await keys(import('../src/testing/index.js'))).toEqual([
      'createConfiguredFakes',
      'createFakeGitHub',
      'createFakeGoogle',
    ]);
  });

  it('shares one error class across entry points', async () => {
    const [api, credentials] = await Promise.all([import('../src/index.js'), import('../src/credentials.js')]);
    expect(credentials.FirebaseWifError).toBe(api.FirebaseWifError);
    expect(credentials.isFirebaseWifError).toBe(api.isFirebaseWifError);
  });
});
