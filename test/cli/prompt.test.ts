import { describe, expect, it } from 'vitest';
import { createAsk } from '../../src/cli/prompt.js';

describe('createAsk', () => {
  it('passes the question and signal to the prompt', async () => {
    const controller = new AbortController();
    const calls: [string, AbortSignal | undefined][] = [];
    const ask = createAsk(async (question, signal) => (calls.push([question, signal]), true), controller.signal);
    expect(await ask('Apply?')).toBe(true);
    expect(calls).toEqual([['Apply?', controller.signal]]);
  });

  it('rejects when interrupted while the prompt was open', async () => {
    const controller = new AbortController();
    const ask = createAsk(async () => (controller.abort(), true), controller.signal);
    await expect(ask('Apply?')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
