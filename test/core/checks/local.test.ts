import { describe, expect, it } from 'vitest';
import { LOCAL_CHECKS } from '../../../src/core/checks/local.js';
import type { Runtime } from '../../../src/core/io/reads.js';
import { runtimeFor } from '../../helpers.js';

const run = (id: string, rt: Runtime) => LOCAL_CHECKS.find((a) => a.id === id)!.run(rt);

describe('local checks', () => {
  it('are in report order', () => {
    expect(LOCAL_CHECKS.map((a) => a.id)).toEqual([
      'local.firebase-json',
      'local.project-match',
      'local.creds-ignored',
    ]);
  });

  it('skip without local files', async () => {
    const rt = await runtimeFor();
    for (const check of LOCAL_CHECKS) {
      expect(await check.run(rt), check.id).toEqual({ status: 'skipped', message: 'no local files provided' });
    }
  });

  it('local.firebase-json', async () => {
    const rt = await runtimeFor();
    expect((await run('local.firebase-json', { ...rt, local: {} })).status).toBe('warn');
    expect((await run('local.firebase-json', { ...rt, local: { firebaseJson: {} } })).status).toBe('pass');
  });

  it('local.project-match', async () => {
    const rt = await runtimeFor();
    expect(await run('local.project-match', { ...rt, local: {} })).toMatchObject({
      status: 'warn',
      fix: 'firebase use --add demo-project',
    });
    expect(
      (await run('local.project-match', { ...rt, local: { firebaserc: { projects: { default: 'demo-project' } } } }))
        .status,
    ).toBe('pass');
    expect(
      (await run('local.project-match', { ...rt, local: { firebaserc: { projects: { default: 'other-project' } } } }))
        .status,
    ).toBe('warn');
    expect(
      await run('local.project-match', {
        ...rt,
        local: { firebaserc: { projects: { default: 'other-project', staging: 'demo-project' } } },
      }),
    ).toEqual({ status: 'pass', message: 'alias staging is demo-project' });
  });

  it('local.creds-ignored', async () => {
    const rt = await runtimeFor();
    const workflows = { 'a.yml': 'jobs:\n  x:\n    steps:\n      - uses: google-github-actions/auth@v3\n' };

    expect((await run('local.creds-ignored', { ...rt, local: { workflows: {} } })).status).toBe('pass');
    expect(
      await run('local.creds-ignored', { ...rt, local: { workflows, firebaseJson: { hosting: [{ public: '.' }] } } }),
    ).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('.gitignore or the Hosting ignore list'),
    });
    expect(
      (
        await run('local.creds-ignored', {
          ...rt,
          local: {
            workflows,
            gitignore: 'gha-creds-*.json\n',
            firebaseJson: { hosting: { public: '.', ignore: ['**/gha-creds-*.json'] } },
          },
        })
      ).status,
    ).toBe('pass');
    expect(
      (
        await run('local.creds-ignored', {
          ...rt,
          local: { workflows, gitignore: 'gha-creds-*.json', firebaseJson: { hosting: { public: 'dist' } } },
        })
      ).status,
    ).toBe('pass');
  });
});
