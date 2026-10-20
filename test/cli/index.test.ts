import { afterEach, describe, expect, it, vi } from 'vitest';

const main = vi.hoisted(() => vi.fn(async () => 7));
vi.mock('../../src/cli/main.js', () => ({ main }));

const exitCode = process.exitCode;

afterEach(() => {
  process.exitCode = exitCode;
});

describe('bin entry point', () => {
  it('runs main with the CLI arguments, a SIGINT signal, and sets the exit code', async () => {
    const listeners = process.listeners('SIGINT');
    await import('../../src/cli/index.js');
    expect(main).toHaveBeenCalledWith(process.argv.slice(2), { signal: expect.any(AbortSignal) });
    expect(process.exitCode).toBe(7);

    const { signal } = (main.mock.calls[0] as unknown as [string[], { signal: AbortSignal }])[1];
    const added = process.listeners('SIGINT').filter((listener) => !listeners.includes(listener));
    expect(added).toHaveLength(1);
    added[0]!('SIGINT');
    expect(signal.aborted).toBe(true);
    for (const listener of process.listeners('SIGINT').filter((l) => !listeners.includes(l)))
      process.off('SIGINT', listener);
  });
});
