import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseGitHubRemote, projectAliases, resolveContext } from '../../src/core/context.js';
import { FirebaseWifError } from '../../src/core/errors.js';

const tempRepo = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 'firebase-wif-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

const noExec = async () => {
  throw new Error('no exec');
};

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/abraham/abrah.am.git', 'abraham/abrah.am'],
    ['https://github.com/abraham/abrah.am', 'abraham/abrah.am'],
    ['git@github.com:abraham/abrah.am.git', 'abraham/abrah.am'],
    ['ssh://git@github.com/abraham/abrah.am.git', 'abraham/abrah.am'],
    ['ssh://git@github.com:22/abraham/abrah.am.git', 'abraham/abrah.am'],
    ['https://token@github.com/gdg-x/hoverboard/', 'gdg-x/hoverboard'],
  ])('%s', (url, repo) => {
    expect(parseGitHubRemote(url)).toBe(repo);
  });

  it('ignores remotes it cannot parse', () => {
    expect(parseGitHubRemote('/local/path/repo')).toBeUndefined();
  });

  it('rejects other hosts', () => {
    expect(() => parseGitHubRemote('git@github.example.com:o/r.git')).toThrow(FirebaseWifError);
    expect(() => parseGitHubRemote('https://gitlab.com/o/r.git')).toThrow(/gitlab\.com/);
  });
});

describe('projectAliases', () => {
  it('lists each project once, default first', async () => {
    const root = await tempRepo({
      '.git/HEAD': '',
      'site/.firebaserc': JSON.stringify({
        projects: { staging: 'demo-staging', default: 'demo-project', prod: 'demo-project', qa: 'demo-qa' },
      }),
    });
    expect(await projectAliases({ cwd: join(root, 'site') })).toEqual([
      { alias: 'default', projectId: 'demo-project' },
      { alias: 'staging', projectId: 'demo-staging' },
      { alias: 'qa', projectId: 'demo-qa' },
    ]);
  });

  it('is empty without .firebaserc', async () => {
    const root = await tempRepo({ '.git/HEAD': '' });
    expect(await projectAliases({ cwd: root })).toEqual([]);
  });
});

describe('resolveContext', () => {
  it('reads .firebaserc, firebase.json, workflows, and the git remote', async () => {
    const root = await tempRepo({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.gitignore': 'node_modules\n',
      'firebase.json': JSON.stringify({ hosting: { public: 'dist' } }),
      '.firebaserc': JSON.stringify({ projects: { default: 'demo-project', staging: 'demo-staging' } }),
      '.github/workflows/deploy.yml': 'on: push\n',
      '.github/workflows/preview.yaml': 'on: pull_request\n',
      '.github/workflows/notes.md': 'not a workflow',
    });
    const exec = vi.fn(async (file: string, args: string[], options?: { cwd?: string }) => {
      expect([file, ...args]).toEqual(['git', 'remote', 'get-url', 'origin']);
      expect(options?.cwd).toBe(join(root, '.github'));
      return 'git@github.com:octo-org/site.git\n';
    });

    const resolved = await resolveContext({ cwd: join(root, '.github'), env: {}, exec });
    expect(resolved).toMatchObject({
      projectId: 'demo-project',
      repo: 'octo-org/site',
      sources: { projectId: '.firebaserc default', repo: 'git remote origin' },
      firebaseJson: { hosting: { public: 'dist' } },
      firebaseDir: root,
      gitRoot: root,
    });
    expect(Object.keys(resolved.local.workflows ?? {})).toEqual(['.github/workflows/deploy.yml', '.github/workflows/preview.yaml']);
    expect(resolved.local.gitignore).toBe('node_modules\n');
    expect(resolved.local.firebaserc?.projects?.staging).toBe('demo-staging');
  });

  it('resolves aliases and explicit values', async () => {
    const root = await tempRepo({ '.git/HEAD': '', '.firebaserc': JSON.stringify({ projects: { staging: 'demo-staging' } }) });
    const alias = await resolveContext({ cwd: root, project: 'staging', repo: 'o/r', env: {}, exec: noExec });
    expect(alias.projectId).toBe('demo-staging');
    expect(alias.sources).toEqual({ projectId: '.firebaserc alias staging', repo: '--repo' });

    const explicit = await resolveContext({ cwd: root, project: 'other-project', repo: 'o/r', env: {}, exec: noExec });
    expect(explicit.projectId).toBe('other-project');
    expect(explicit.sources.projectId).toBe('--project');
  });

  it('falls back to environment variables', async () => {
    const root = await tempRepo({ '.git/HEAD': '' });
    const resolved = await resolveContext({
      cwd: root,
      env: { GCLOUD_PROJECT: 'env-project', GITHUB_REPOSITORY: 'o/r' },
      exec: noExec,
    });
    expect(resolved).toMatchObject({ projectId: 'env-project', repo: 'o/r', sources: { projectId: 'GCLOUD_PROJECT', repo: 'GITHUB_REPOSITORY' } });
    expect(resolved.local.firebaseJson).toBeUndefined();
    expect(resolved.local.workflows).toEqual({});
  });

  it('falls back to gh repo view', async () => {
    const root = await tempRepo({ '.git/HEAD': '' });
    const exec = vi.fn(async (file: string) => {
      if (file === 'git') throw new Error('no remote');
      return 'o/from-gh\n';
    });
    const resolved = await resolveContext({ cwd: root, project: 'p-123456', env: {}, exec });
    expect(resolved.repo).toBe('o/from-gh');
    expect(resolved.sources.repo).toBe('gh repo view');
  });

  it("doesn't look for firebase.json above the git root", async () => {
    const outer = await tempRepo({ 'firebase.json': '{}', 'inner/.git/HEAD': '' });
    const resolved = await resolveContext({ cwd: join(outer, 'inner'), project: 'p-123456', repo: 'o/r', env: {}, exec: noExec });
    expect(resolved.firebaseDir).toBeUndefined();
  });

  it('explains what is missing or broken', async () => {
    const root = await tempRepo({ '.git/HEAD': '' });
    await expect(resolveContext({ cwd: root, env: {}, exec: noExec })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(resolveContext({ cwd: root, project: 'p-123456', env: {}, exec: noExec })).rejects.toMatchObject({
      code: 'REPO_NOT_FOUND',
    });

    const broken = await tempRepo({ '.git/HEAD': '', 'firebase.json': '{ nope' });
    await expect(resolveContext({ cwd: broken, project: 'p-123456', repo: 'o/r', env: {}, exec: noExec })).rejects.toThrow(
      /firebase\.json is not valid JSON/,
    );
  });
});
