import type { ChangeAction, Check, Context, Plan, StatusReport } from '../core/types.js';

const SYMBOLS: Record<Check['status'], string> = { pass: '✓', warn: '!', fail: '✗', skipped: '-' };

const SIGNS: Record<ChangeAction, string> = {
  create: '+',
  enable: '+',
  undelete: '+',
  bind: '+',
  set: '~',
  update: '~',
  unbind: '-',
};

const GROUPS: [prefix: string, title: string][] = [
  ['local.', 'Local'],
  ['gcp.', 'Google Cloud'],
  ['gh.', 'GitHub'],
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export interface Sources {
  projectId: string;
  repo: string;
}

const header = (title: string, ctx: Context, sources: Sources) => [
  title,
  `  project  ${ctx.projectId} (#${ctx.projectNumber}, from ${sources.projectId})`,
  `  repo     ${ctx.repo} (id ${ctx.repoId}, from ${sources.repo})`,
  ...(ctx.homeProjectId && ctx.homeProjectId !== ctx.projectId
    ? [`  home     ${ctx.homeProjectId} (shares its provider and service account)`]
    : []),
];

export const renderPlan = (plan: Plan, sources: Sources): string => {
  const { context: ctx, changes } = plan;
  const lines = header('firebase-wif setup', ctx, sources);
  if (ctx.adopted) {
    const { variables } = ctx.adopted;
    lines.push(
      `  adopt    ${ctx.adopted.provider}`,
      `           ${ctx.adopted.serviceAccount} (from ${variables.provider} and ${variables.serviceAccount})`,
    );
  }
  if (!changes.length) {
    lines.push('', '  Already set up.', '');
    return lines.join('\n');
  }
  const automatic = changes.filter((change) => !change.manual);
  const manual = changes.filter((change) => change.manual);
  if (automatic.length)
    lines.push('', '  Changes', ...automatic.map((change) => `    ${SIGNS[change.action]} ${change.description}`));
  if (manual.length) lines.push('', '  Do by hand', ...manual.map((change) => `    - ${change.description}`));
  lines.push('');
  return lines.join('\n');
};

export const renderStatus = (report: StatusReport, sources: Sources): string => {
  const { context: ctx, checks } = report;
  const width = Math.max(...checks.map((check) => check.id.length));
  const lines = header('firebase-wif status', ctx, sources);

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
