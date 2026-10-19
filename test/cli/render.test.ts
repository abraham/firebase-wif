import { describe, expect, it } from 'vitest';
import { renderStatus } from '../../src/cli/render.js';
import type { Check, StatusReport } from '../../src/core/types.js';

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

  it('omits empty groups and the skipped count', () => {
    const output = renderStatus(
      report([
        { id: 'gcp.project', status: 'pass', message: 'ok' },
        { id: 'gcp.operator', status: 'warn', message: 'a' },
        { id: 'gcp.sa-keys', status: 'warn', message: 'b' },
      ]),
      sources,
    );
    expect(output).not.toContain('Local');
    expect(output).not.toContain('GitHub');
    expect(output).toContain('  0 failed, 2 warnings, 1 passed\n');
  });
});
