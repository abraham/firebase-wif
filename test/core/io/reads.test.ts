import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../src/core/errors.js';
import { createMemo, read } from '../../../src/core/io/reads.js';

describe('read', () => {
  it('turns responses into found, missing, or skipped', async () => {
    expect(await read(async () => 1)).toEqual({ kind: 'found', value: 1 });
    expect(await read(() => Promise.reject(new HttpError(404, 'gone')))).toEqual({ kind: 'missing' });
    expect(await read(() => Promise.reject(new HttpError(403, 'denied')))).toEqual({
      kind: 'skipped',
      reason: 'insufficient permission (denied)',
    });
    expect(await read(() => Promise.reject(new HttpError(500, 'boom')))).toEqual({
      kind: 'skipped',
      reason: 'request failed (500): boom',
    });
    expect(await read(() => Promise.reject('weird'))).toEqual({
      kind: 'skipped',
      reason: 'request failed: unknown error',
    });
  });

  it('truncates long messages', async () => {
    const result = await read(() => Promise.reject(new HttpError(500, 'x'.repeat(500))));
    expect(result.kind === 'skipped' && result.reason.length).toBeLessThan(240);
  });

  it('rethrows aborts', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await expect(read(() => Promise.reject(abort))).rejects.toBe(abort);
  });
});

describe('createMemo', () => {
  it('loads each key once', async () => {
    const memo = createMemo();
    const load = vi.fn(async () => 'value');
    expect(await Promise.all([memo('a', load), memo('a', load)])).toEqual(['value', 'value']);
    await memo('b', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
