import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runPost } from '../../src/action/post.js';

const post = async (path?: string) => {
  let stdout = '';
  const code = await runPost({ env: path === undefined ? {} : { STATE_credentials_path: path }, stdout: (text) => (stdout += text) });
  return { code, stdout };
};

const exists = (path: string) => access(path).then(() => true, () => false);

describe('runPost', () => {
  it('deletes the credentials file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'firebase-wif-post-')), 'creds.json');
    await writeFile(path, '{}');
    expect(await post(path)).toEqual({ code: 0, stdout: `Removed ${path}.\n` });
    expect(await exists(path)).toBe(false);
  });

  it("is fine when the file is already gone or main didn't run", async () => {
    expect((await post('/nonexistent/firebase-wif.json')).code).toBe(0);
    expect(await post()).toEqual({ code: 0, stdout: '' });
  });

  it('warns instead of failing the job when it cannot delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'firebase-wif-post-'));
    await mkdir(join(dir, 'busy'));
    const { code, stdout } = await post(join(dir, 'busy'));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^::warning::Couldn't remove /);
  });
});

describe('dist/action/post.js', () => {
  it('runs as the bundled entry point', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'firebase-wif-post-')), 'creds.json');
    await writeFile(path, '{}');
    await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../dist/action/post.js')], {
      env: { STATE_credentials_path: path },
    });
    expect(await exists(path)).toBe(false);
  });
});
