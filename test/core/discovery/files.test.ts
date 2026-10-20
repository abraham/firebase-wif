import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFirebaseFiles, readText, readWorkflows } from '../../../src/core/discovery/files.js';

const tempDir = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 'firebase-wif-files-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

describe('findFirebaseFiles', () => {
  it('finds firebase.json and .firebaserc above the start directory, up to the git root', async () => {
    const root = await tempDir({
      '.git/HEAD': '',
      'firebase.json': '{"hosting":{}}',
      '.firebaserc': '{"projects":{"default":"p"}}',
      'site/src/index.ts': '',
    });
    expect(await findFirebaseFiles(join(root, 'site', 'src'))).toEqual({
      gitRoot: root,
      firebaseDir: root,
      firebaseJson: { hosting: {} },
      firebaserc: { projects: { default: 'p' } },
    });
  });

  it('rejects invalid JSON', async () => {
    const root = await tempDir({ '.git/HEAD': '', 'firebase.json': '{' });
    await expect(findFirebaseFiles(root)).rejects.toMatchObject({ code: 'INVALID_NAME' });
  });
});

describe('readWorkflows', () => {
  it('reads YAML workflows in name order, and nothing without a workflows directory', async () => {
    const root = await tempDir({
      '.github/workflows/b.yaml': 'b',
      '.github/workflows/a.yml': 'a',
      '.github/workflows/notes.md': 'x',
    });
    expect(await readWorkflows(root)).toEqual({ '.github/workflows/a.yml': 'a', '.github/workflows/b.yaml': 'b' });
    expect(await readWorkflows(await tempDir({}))).toEqual({});
  });
});

describe('readText', () => {
  it('returns undefined for missing files', async () => {
    expect(await readText(join(await tempDir({}), 'missing'))).toBeUndefined();
  });
});
