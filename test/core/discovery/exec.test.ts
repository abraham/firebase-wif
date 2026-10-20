import { describe, expect, it } from 'vitest';
import { defaultExec } from '../../../src/core/discovery/exec.js';

describe('defaultExec', () => {
  it('runs a command without a shell in the given directory', async () => {
    const out = await defaultExec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: '/',
    });
    expect(out).toBe('/');
  });

  it("doesn't interpret shell syntax", async () => {
    const out = await defaultExec(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi)']);
    expect(out).toBe('$(echo hi)');
  });
});
