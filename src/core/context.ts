import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defaultExec, type Exec } from './clients.js';
import { FirebaseWifError } from './errors.js';
import type { LocalFiles } from './types.js';

export interface ResolvedContext {
  projectId: string;
  repo: string;
  firebaseJson?: Record<string, unknown>;
  local: LocalFiles;
  /** Where each value came from, for display. */
  sources: { projectId: string; repo: string };
  /** Directory containing `firebase.json`/`.firebaserc`, if found. */
  firebaseDir?: string;
  gitRoot?: string;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const readText = async (path: string): Promise<string | undefined> => {
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

const tryExec = async (exec: Exec, file: string, args: string[], cwd: string) => {
  try {
    return (await exec(file, args, { cwd })).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Parses https, ssh, and scp-style GitHub remotes into `owner/name`. */
export const parseGitHubRemote = (url: string): string | undefined => {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!match) return undefined;
  const [, host, owner, name] = match;
  if (host !== 'github.com') {
    throw new FirebaseWifError(
      'REPO_NOT_FOUND',
      `Only github.com repositories are supported; the git remote points at ${host}.`,
      { fix: 'Pass --repo owner/name for a github.com repository.' },
    );
  }
  return `${owner}/${name}`;
};

/** Searches upward from `start` to the git root for `firebase.json`/`.firebaserc`. */
const findFirebaseFiles = async (start: string) => {
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

export interface ProjectAlias {
  alias: string;
  projectId: string;
}

/** Each project in `.firebaserc` once, under its first alias, with `default` first. */
export const projectAliases = async ({ cwd = process.cwd() }: { cwd?: string } = {}): Promise<ProjectAlias[]> => {
  const { firebaserc } = await findFirebaseFiles(resolve(cwd));
  const projects = firebaserc?.projects ?? {};
  const names = Object.keys(projects).sort((a, b) => Number(b === 'default') - Number(a === 'default'));
  const seen = new Set<string>();
  const aliases: ProjectAlias[] = [];
  for (const alias of names) {
    const projectId = projects[alias];
    if (typeof projectId !== 'string' || seen.has(projectId)) continue;
    seen.add(projectId);
    aliases.push({ alias, projectId });
  }
  return aliases;
};

const readWorkflows = async (root: string): Promise<Record<string, string>> => {
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
 * Discovers the Firebase project, GitHub repo, and local files for a working directory.
 * This is the only function that reads the filesystem, environment, and git remote.
 */
export const resolveContext = async ({
  cwd = process.cwd(),
  project,
  repo,
  env = process.env,
  exec = defaultExec,
}: {
  cwd?: string;
  project?: string;
  repo?: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
} = {}): Promise<ResolvedContext> => {
  const start = resolve(cwd);
  const { gitRoot, firebaseDir, firebaseJson, firebaserc } = await findFirebaseFiles(start);
  const aliases = firebaserc?.projects ?? {};

  let projectId: string | undefined;
  let projectSource = '';
  if (project) {
    projectId = aliases[project] ?? project;
    projectSource = aliases[project] ? `.firebaserc alias ${project}` : '--project';
  } else if (aliases.default) {
    projectId = aliases.default;
    projectSource = '.firebaserc default';
  } else if (env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT) {
    projectId = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
    projectSource = env.GOOGLE_CLOUD_PROJECT ? 'GOOGLE_CLOUD_PROJECT' : 'GCLOUD_PROJECT';
  }
  if (!projectId) {
    throw new FirebaseWifError('PROJECT_NOT_FOUND', 'Could not find a Firebase project.', {
      fix: 'Pass --project, or add a default project to .firebaserc.',
    });
  }

  let repoName: string | undefined;
  let repoSource = '';
  if (repo) {
    repoName = repo;
    repoSource = '--repo';
  } else if (env.GITHUB_REPOSITORY) {
    repoName = env.GITHUB_REPOSITORY;
    repoSource = 'GITHUB_REPOSITORY';
  } else {
    const remote = await tryExec(exec, 'git', ['remote', 'get-url', 'origin'], start);
    repoName = remote ? parseGitHubRemote(remote) : undefined;
    if (repoName) {
      repoSource = 'git remote origin';
    } else {
      repoName = await tryExec(
        exec,
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        start,
      );
      repoSource = 'gh repo view';
    }
  }
  if (!repoName) {
    throw new FirebaseWifError('REPO_NOT_FOUND', 'Could not find the GitHub repository.', {
      fix: 'Pass --repo owner/name.',
    });
  }

  const root = gitRoot ?? firebaseDir ?? start;
  return {
    projectId,
    repo: repoName,
    firebaseJson,
    local: {
      firebaseJson,
      firebaserc,
      gitignore: await readText(join(root, '.gitignore')),
      workflows: await readWorkflows(root),
    },
    sources: { projectId: projectSource, repo: repoSource },
    firebaseDir,
    gitRoot,
  };
};
