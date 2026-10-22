import { describe, expect, it } from 'vitest';
import { renderPlan, renderStatus } from '../../src/cli/render.js';
import type { Change, Check, Plan, StatusReport } from '../../src/core/types.js';

const report = (checks: Check[]): StatusReport =>
  ({
    ok: !checks.some((c) => c.status === 'fail'),
    checks,
    changes: [],
    preflight: { missingPermissions: [], githubAdmin: true },
    context: { projectId: 'demo-project', projectNumber: '123', repo: 'o/r', repoId: 42 },
  }) as unknown as StatusReport;

const sources = { projectId: '--project', repo: '--repo' };

describe('renderStatus', () => {
  it('groups checks and shows fixes only for problems', () => {
    const output = renderStatus(
      report([
        { id: 'gh.repo', status: 'pass', message: 'o/r', fix: 'never shown' },
        { id: 'local.firebase-json', status: 'warn', message: 'missing', fix: 'firebase init' },
        { id: 'gcp.pool', status: 'fail', message: 'create pool', fix: 'firebase-wif setup' },
        { id: 'gh.variables', status: 'skipped', message: 'no GitHub credentials', fix: 'set them by hand' },
      ]),
      sources,
      true,
    );
    expect(output).toBe(
      [
        'firebase-wif status',
        '  project  demo-project (#123, from --project)',
        '  repo     o/r (id 42, from --repo)',
        '',
        '  Local',
        '    ! local.firebase-json  missing',
        '        fix: firebase init',
        '',
        '  Google Cloud',
        '    ✗ gcp.pool             create pool',
        '        fix: firebase-wif setup',
        '',
        '  GitHub',
        '    ✓ gh.repo              o/r',
        '    - gh.variables         no GitHub credentials',
        '        fix: set them by hand',
        '',
        '  1 failed, 1 warning, 1 passed, 1 skipped',
        '',
      ].join('\n'),
    );
  });

  it('uses plain labels and change summaries unless detailed', () => {
    const pool: Change = {
      resource: 'gcp.pool',
      action: 'create',
      description: 'create pool github',
      summary: 'create the pool',
    };
    const output = renderStatus(
      {
        ...report([
          { id: 'gh.repo', status: 'pass', message: 'o/r' },
          { id: 'local.firebase-json', status: 'warn', message: 'missing', fix: 'firebase init' },
          { id: 'gcp.pool', status: 'fail', message: 'create pool github', fix: 'firebase-wif setup' },
        ]),
        changes: [pool],
      },
      sources,
      false,
    );
    expect(output).toBe(
      [
        'firebase-wif status',
        '  project  demo-project (from --project)',
        '  repo     o/r (from --repo)',
        '',
        '  Local',
        '    ! firebase.json found',
        '        missing',
        '        fix: firebase init',
        '',
        '  Google Cloud',
        '    ✗ GitHub identity pool',
        '        create the pool',
        '        fix: firebase-wif setup',
        '',
        '  GitHub',
        '    ✓ Repo admin access',
        '',
        '  1 failed, 1 warning, 1 passed',
        '',
      ].join('\n'),
    );
  });

  it('omits empty groups and the skipped count', () => {
    const output = renderStatus(
      report([
        { id: 'gcp.project', status: 'pass', message: 'ok' },
        { id: 'gcp.operator', status: 'warn', message: 'a' },
        { id: 'gcp.sa-keys', status: 'warn', message: 'b' },
      ]),
      sources,
      true,
    );
    expect(output).not.toContain('Local');
    expect(output).not.toContain('GitHub');
    expect(output).toContain('  0 failed, 2 warnings, 1 passed\n');
  });
});

const planOf = (changes: Change[], context: Partial<Plan['context']> = {}): Plan =>
  ({
    context: { projectId: 'demo-project', projectNumber: '123', repo: 'o/r', repoId: 42, ...context },
    changes,
    preflight: { missingPermissions: [], githubAdmin: true },
    apply: async () => {
      throw new Error('not used');
    },
  }) as Plan;

describe('renderPlan', () => {
  const changes: Change[] = [
    { resource: 'gcp.pool', action: 'create', description: 'create pool', summary: 'create the pool' },
    { resource: 'gcp.provider', action: 'update', description: 'patch provider', summary: 'fix sign-in' },
    { resource: 'gcp.project-roles', action: 'unbind', description: 'remove roles/editor', summary: 'remove editor' },
    { resource: 'gh.variables', action: 'set', description: 'set A to x', summary: 'set A', manual: true },
  ];

  it('lists automatic changes with a sign per action, then manual steps', () => {
    const output = renderPlan(planOf(changes), sources, true);
    expect(output).toBe(
      [
        'firebase-wif setup',
        '  project  demo-project (#123, from --project)',
        '  repo     o/r (id 42, from --repo)',
        '',
        '  Changes',
        '    + create pool',
        '    ~ patch provider',
        '    - remove roles/editor',
        '',
        '  Do by hand',
        '    - set A to x',
        '',
      ].join('\n'),
    );
  });

  it('uses summaries unless detailed, but keeps manual steps exact', () => {
    expect(renderPlan(planOf(changes), sources, false)).toBe(
      [
        'firebase-wif setup',
        '  project  demo-project (from --project)',
        '  repo     o/r (from --repo)',
        '',
        '  Changes',
        '    + create the pool',
        '    ~ fix sign-in',
        '    - remove editor',
        '',
        '  Do by hand',
        '    - set A to x',
        '',
      ].join('\n'),
    );
  });

  it('names the home project when the trust chain is shared', () => {
    const output = renderPlan(planOf([], { homeProjectId: 'home-project' }), sources, false);
    expect(output).toContain('  home     home-project (shares its provider and service account)\n');
    expect(renderPlan(planOf([], { homeProjectId: 'demo-project' }), sources, false)).not.toContain('home ');
  });

  it('says when there is nothing to do and shows adoption', () => {
    const adopted = planOf([], {
      adopted: {
        provider: 'projects/1/p',
        serviceAccount: 'sa@x.iam.gserviceaccount.com',
        variables: { provider: 'P', serviceAccount: 'S' },
      },
    });
    const output = renderPlan(adopted, sources, true);
    expect(output).toContain('  adopt    projects/1/p\n           sa@x.iam.gserviceaccount.com (from P and S)\n');
    expect(output.endsWith('\n  Already set up.\n')).toBe(true);
    expect(output).not.toContain('Changes');
    expect(renderPlan(adopted, sources, false)).toContain('  adopt    the existing setup in P and S\n');
  });
});
