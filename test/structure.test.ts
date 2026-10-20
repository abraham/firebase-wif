import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('test layout', () => {
  it('has a test file for every source file', async () => {
    const sources = (await readdir(join(root, 'src'), { recursive: true })).filter((file) => file.endsWith('.ts'));
    const missing = [];
    for (const source of sources) {
      const test = join(root, 'test', source.replace(/\.ts$/, '.test.ts'));
      try {
        await access(test);
      } catch {
        missing.push(source);
      }
    }
    expect(missing).toEqual([]);
  });

  it('builds the CLI only on the public entry points', async () => {
    const allowed = ['../index.js', '../presets.js', '../credentials.js', '../gh.js', '../testing/index.js'];
    const files = (await readdir(join(root, 'src', 'cli'))).filter((file) => file.endsWith('.ts'));
    const internal = [];
    for (const file of files) {
      const text = await readFile(join(root, 'src', 'cli', file), 'utf8');
      for (const [, specifier] of text.matchAll(/from '([^']+)'/g)) {
        if (specifier!.startsWith('../') && !allowed.includes(specifier!)) internal.push(`${file}: ${specifier}`);
      }
    }
    expect(internal).toEqual([]);
  });

  it('builds the Action only on /credentials', async () => {
    const files = (await readdir(join(root, 'src', 'action'))).filter((file) => file.endsWith('.ts'));
    const internal = [];
    for (const file of files) {
      const text = await readFile(join(root, 'src', 'action', file), 'utf8');
      for (const [, specifier] of text.matchAll(/from '([^']+)'/g)) {
        if (specifier!.startsWith('../') && specifier !== '../credentials.js') internal.push(`${file}: ${specifier}`);
      }
    }
    expect(internal).toEqual([]);
  });
});
