import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { FirebaseWifError } from '../errors.js';
import type { LocalFiles } from '../types.js';
import { deployDirectories } from '../workflow-steps.js';

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** A file's text, or `undefined` when it can't be read. */
export const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

const readJsonFile = async <T>(path: string): Promise<T | undefined> => {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FirebaseWifError('INVALID_NAME', `${path} is not valid JSON.`);
  }
};

const findUp = async (start: string, stopAt: string | undefined, test: (dir: string) => Promise<boolean>) => {
  let dir = start;
  for (;;) {
    if (await test(dir)) return dir;
    const parent = dirname(dir);
    if (dir === stopAt || parent === dir) return undefined;
    dir = parent;
  }
};

/** Searches upward from `start` to the git root for `firebase.json`/`.firebaserc`. */
export const findFirebaseFiles = async (start: string) => {
  const gitRoot = await findUp(start, undefined, (dir) => exists(join(dir, '.git')));
  const firebaseDir = await findUp(
    start,
    gitRoot,
    async (dir) => (await exists(join(dir, 'firebase.json'))) || (await exists(join(dir, '.firebaserc'))),
  );
  const firebaseJson = firebaseDir
    ? await readJsonFile<Record<string, unknown>>(join(firebaseDir, 'firebase.json'))
    : undefined;
  const firebaserc = firebaseDir
    ? await readJsonFile<LocalFiles['firebaserc']>(join(firebaseDir, '.firebaserc'))
    : undefined;
  return { gitRoot, firebaseDir, firebaseJson, firebaserc };
};

/** Workflow file contents under `root`, keyed by path like `.github/workflows/deploy.yml`. */
export const readWorkflows = async (root: string): Promise<Record<string, string>> => {
  const dir = join(root, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return {};
  }
  const workflows: Record<string, string> = {};
  for (const entry of entries.filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const text = await readText(join(dir, entry));
    if (text !== undefined) workflows[`.github/workflows/${entry}`] = text;
  }
  return workflows;
};

/**
 * `firebase.json` files in the directories the workflows deploy from, keyed by path from `root`, skipping
 * `skip` (the one already read) and directories outside `root`.
 */
export const readDeployFirebaseJsons = async (
  root: string,
  workflows: Record<string, string>,
  skip: string | undefined,
): Promise<Record<string, Record<string, unknown>>> => {
  const found: Record<string, Record<string, unknown>> = {};
  for (const directory of deployDirectories(workflows)) {
    const path = resolve(root, directory, 'firebase.json');
    const key = relative(root, path);
    if (path === skip || key.startsWith(`..${sep}`) || resolve(key) === key) continue;
    const firebaseJson = await readJsonFile<Record<string, unknown>>(path);
    if (firebaseJson) found[key.split(sep).join('/')] = firebaseJson;
  }
  return found;
};
