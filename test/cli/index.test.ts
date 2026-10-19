import { afterEach, describe, expect, it, vi } from 'vitest';

const main = vi.hoisted(() => vi.fn(async () => 7));
vi.mock('../../src/cli/main.js', () => ({ main }));

const exitCode = process.exitCode;

afterEach(() => {
  process.exitCode = exitCode;
});

describe('bin entry point', () => {
  it('runs main with the CLI arguments and sets the exit code', async () => {
    await import('../../src/cli/index.js');
    expect(main).toHaveBeenCalledWith(process.argv.slice(2));
    expect(process.exitCode).toBe(7);
  });
});
