import { access, readdir } from 'node:fs/promises';
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
});
