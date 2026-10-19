import { rm } from 'node:fs/promises';
import { createCore, CREDENTIALS_PATH_STATE, isEntryPoint } from './core.js';

/** Deletes the credentials file main wrote; a file that's already gone is fine. */
export const runPost = async ({
  env = process.env,
  stdout,
}: { env?: NodeJS.ProcessEnv; stdout?: (text: string) => void } = {}): Promise<number> => {
  const core = createCore({ env, stdout });
  const path = core.getState(CREDENTIALS_PATH_STATE);
  if (!path) return 0;
  try {
    await rm(path, { force: true });
    core.info(`Removed ${path}.`);
  } catch (error) {
    core.warning(`Couldn't remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
};

if (isEntryPoint(import.meta.url)) process.exitCode = await runPost();
