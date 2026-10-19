import type { Check, StatusReport } from '../core/types.js';

const SYMBOLS: Record<Check['status'], string> = { pass: '✓', warn: '!', fail: '✗', skipped: '-' };

const GROUPS: [prefix: string, title: string][] = [
  ['local.', 'Local'],
  ['gcp.', 'Google Cloud'],
  ['gh.', 'GitHub'],
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export const renderStatus = (report: StatusReport, sources: { projectId: string; repo: string }): string => {
  const { context: ctx, checks } = report;
  const width = Math.max(...checks.map((check) => check.id.length));
  const lines = [
    'firebase-wif status',
    `  project  ${ctx.projectId} (#${ctx.projectNumber}, from ${sources.projectId})`,
    `  repo     ${ctx.repo} (id ${ctx.repoId}, from ${sources.repo})`,
  ];

  for (const [prefix, title] of GROUPS) {
    const group = checks.filter((check) => check.id.startsWith(prefix));
    if (!group.length) continue;
    lines.push('', `  ${title}`);
    for (const check of group) {
      lines.push(`    ${SYMBOLS[check.status]} ${check.id.padEnd(width)}  ${check.message}`);
      if (check.fix && check.status !== 'pass') lines.push(`        fix: ${check.fix}`);
    }
  }

  const count = (status: Check['status']) => checks.filter((check) => check.status === status).length;
  const summary = [
    `${count('fail')} failed`,
    plural(count('warn'), 'warning'),
    `${count('pass')} passed`,
    ...(count('skipped') ? [`${count('skipped')} skipped`] : []),
  ];
  lines.push('', `  ${summary.join(', ')}`, '');
  return lines.join('\n');
};
