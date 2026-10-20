import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

  it('keeps core layers pointing one way', async () => {
    // Files directly in src/core are the shared kernel; each folder is a layer.
    const allowed: Record<string, string[]> = {
      kernel: ['kernel'],
      discovery: ['kernel', 'discovery'],
      io: ['kernel', 'io'],
      resources: ['kernel', 'io', 'resources'],
      checks: ['kernel', 'io', 'checks'],
      engine: ['kernel', 'discovery', 'io', 'resources', 'checks', 'engine'],
    };
    const core = join(root, 'src', 'core');
    const layerOf = (path: string) => {
      const parts = relative(core, path).split(sep);
      return parts.length > 1 ? parts[0]! : 'kernel';
    };
    const files = (await readdir(core, { recursive: true })).filter((file) => file.endsWith('.ts'));
    const violations = [];
    for (const file of files) {
      const path = join(core, file);
      const from = layerOf(path);
      expect(allowed[from], `unknown layer ${from}`).toBeDefined();
      for (const [, specifier] of (await readFile(path, 'utf8')).matchAll(/from '(\.[^']+)'/g)) {
        const target = resolve(dirname(path), specifier!);
        if (relative(core, target).startsWith('..')) continue;
        const to = layerOf(target);
        if (!allowed[from]!.includes(to)) violations.push(`${file} (${from}) imports ${specifier} (${to})`);
      }
    }
    expect(violations).toEqual([]);
  });
});
