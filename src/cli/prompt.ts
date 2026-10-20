import { createInterface } from 'node:readline/promises';

export type Prompt = (question: string, signal?: AbortSignal) => Promise<boolean>;

/** Asks a yes/no question; rejects once the run is interrupted. */
export type Ask = (question: string) => Promise<boolean>;

export const askOnTerminal: Prompt = async (question, signal) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // In raw mode, Ctrl-C reaches readline as a key instead of a signal.
  rl.on('SIGINT', () => process.emit('SIGINT'));
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `, { signal })).trim());
  } finally {
    rl.close();
  }
};

/** Wraps `prompt` so an answer given after Ctrl-C still stops the run. */
export const createAsk =
  (prompt: Prompt, signal?: AbortSignal): Ask =>
  async (question) => {
    const answer = await prompt(question, signal);
    signal?.throwIfAborted();
    return answer;
  };
