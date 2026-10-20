import { join, resolve } from 'node:path';
import { FirebaseWifError } from '../errors.js';
import type { LocalFiles } from '../types.js';
import { defaultExec, type Exec } from './exec.js';
import { findFirebaseFiles, readText, readWorkflows } from './files.js';

export interface ResolvedContext {
  projectId: string;
  repo: string;
  local: LocalFiles;
  /** Where each value came from, for display. */
  sources: { projectId: string; repo: string };
  /** Directory containing `firebase.json`/`.firebaserc`, if found. */
  firebaseDir?: string | undefined;
  gitRoot?: string | undefined;
}

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

export interface ProjectAlias {
  alias: string;
  projectId: string;
}

/** Each project in `.firebaserc` once, under its first alias, with `default` first. */
export const projectAliases = async ({ cwd = process.cwd() }: { cwd?: string | undefined } = {}): Promise<
  ProjectAlias[]
> => {
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
  cwd?: string | undefined;
  project?: string | undefined;
  repo?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
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
