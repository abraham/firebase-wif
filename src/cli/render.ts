import type { ChangeAction, Check, Context, Plan, ResolvedContext, StatusReport } from '../index.js';

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

const LABELS: Record<Check['id'], string> = {
  'local.firebase-json': 'firebase.json found',
  'local.project-match': 'Project listed in .firebaserc',
  'local.creds-ignored': 'Credential files kept out of git and Hosting',
  'gcp.project': 'Project found',
  'gcp.operator': 'You can run setup',
  'gcp.apis': 'Google Cloud APIs turned on',
  'gcp.pool': 'GitHub identity pool',
  'gcp.provider': 'GitHub sign-in',
  'gcp.provider-condition': 'Only this repo can sign in',
  'gcp.service-account': 'Deploy account',
  'gcp.sa-keys': 'No deploy account keys',
  'gcp.project-roles': 'Deploy account access',
  'gcp.extra-roles': 'No extra deploy account access',
  'gcp.wi-user': 'This repo can deploy with the deploy account',
  'gcp.wi-user-broad': 'Only this repo can deploy with the deploy account',
  'gcp.runtime-sa-user': 'Deploy account can run functions',
  'gh.repo': 'Repo admin access',
  'gh.variables': 'Repo variables',
  'gh.environment': 'Deploy environment',
  'gh.legacy-secrets': 'No old deploy secrets',
  'gh.oidc-sub': 'OIDC subject fits',
  'gh.workflows': 'Deploy workflows',
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export type Sources = ResolvedContext['sources'];

const header = (title: string, ctx: Context, sources: Sources, detailed: boolean) => [
  title,
  detailed
    ? `  project  ${ctx.projectId} (#${ctx.projectNumber}, from ${sources.projectId})`
    : `  project  ${ctx.projectId} (from ${sources.projectId})`,
  detailed
    ? `  repo     ${ctx.repo} (id ${ctx.repoId}, from ${sources.repo})`
    : `  repo     ${ctx.repo} (from ${sources.repo})`,
  ...(ctx.homeProjectId && ctx.homeProjectId !== ctx.projectId
    ? [`  home     ${ctx.homeProjectId} (shares its provider and service account)`]
    : []),
];

/** `detailed` shows resource names, emails, role IDs, and check IDs. */
export const renderPlan = (plan: Plan, sources: Sources, detailed: boolean): string => {
  const { context: ctx, changes } = plan;
  const lines = header('firebase-wif setup', ctx, sources, detailed);
  if (ctx.adopted) {
    const { variables } = ctx.adopted;
    lines.push(
      ...(detailed
        ? [
            `  adopt    ${ctx.adopted.provider}`,
            `           ${ctx.adopted.serviceAccount} (from ${variables.provider} and ${variables.serviceAccount})`,
          ]
        : [`  adopt    the existing setup in ${variables.provider} and ${variables.serviceAccount}`]),
    );
  }
  if (!changes.length) {
    lines.push('', '  Already set up.', '');
    return lines.join('\n');
  }
  const automatic = changes.filter((change) => !change.manual);
  const manual = changes.filter((change) => change.manual);
  if (automatic.length)
    lines.push(
      '',
      '  Changes',
      ...automatic.map((change) => `    ${SIGNS[change.action]} ${detailed ? change.description : change.summary}`),
    );
  // Steps done by hand need the exact names and values.
  if (manual.length) lines.push('', '  Do by hand', ...manual.map((change) => `    - ${change.description}`));
  lines.push('');
  return lines.join('\n');
};

export const renderStatus = (report: StatusReport, sources: Sources, detailed: boolean): string => {
  const { context: ctx, checks } = report;
  const width = Math.max(...checks.map((check) => check.id.length));
  const lines = header('firebase-wif status', ctx, sources, detailed);

  for (const [prefix, title] of GROUPS) {
    const group = checks.filter((check) => check.id.startsWith(prefix));
    if (!group.length) continue;
    lines.push('', `  ${title}`);
    for (const check of group) {
      if (detailed) {
        lines.push(`    ${SYMBOLS[check.status]} ${check.id.padEnd(width)}  ${check.message}`);
      } else {
        lines.push(`    ${SYMBOLS[check.status]} ${LABELS[check.id]}`);
        if (check.status === 'pass') continue;
        const changes = report.changes.filter((change) => change.resource === check.id);
        const details =
          check.status !== 'skipped' && changes.length ? changes.map((change) => change.summary) : [check.message];
        lines.push(...details.map((detail) => `        ${detail}`));
      }
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
