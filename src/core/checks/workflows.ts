import { parse } from 'yaml';

export interface WorkflowFinding {
  file: string;
  job: string;
  problems: string[];
}

export interface WorkflowAnalysis {
  deployJobs: number;
  /** Jobs that deploy only to preview channels. */
  previewJobs: number;
  /** Environments that preview jobs name, in file order, without duplicates or expressions. */
  previewEnvironments: string[];
  findings: WorkflowFinding[];
  /** Some step writes `google-github-actions/auth` credential files into the workspace. */
  writesCredentialsToWorkspace: boolean;
  parseErrors: string[];
}

interface Step {
  uses?: unknown;
  run?: unknown;
  with?: Record<string, unknown>;
}

interface Job {
  if?: unknown;
  environment?: unknown;
  permissions?: unknown;
  steps?: unknown;
}

/** The environments deploy jobs should use; `undefined` skips that check. */
export interface ExpectedEnvironments {
  live?: { name: string; branch: string | false } | undefined;
  preview?: string | undefined;
}

type Channel = 'live' | 'preview' | 'unknown';

const HOSTING_DEPLOY = 'FirebaseExtended/action-hosting-deploy';
const FIREBASE_ACTION = 'w9jds/firebase-action';
const AUTH_ACTIONS = ['abraham/firebase-wif', 'google-github-actions/auth'];
const LIVE_COMMAND = /\bfirebase(?:-tools)?(?:@\S+)?\s+deploy\b/;
const PREVIEW_COMMAND = /\bfirebase(?:-tools)?(?:@\S+)?\s+hosting:channel:deploy\b/;
const SAME_REPO_GUARD = /head\.repo\.(?:full_name|fork)/;

const isExpression = (value: string) => value.includes('${{');

// GitHub resolves action owners and repos case-insensitively.
const usesAction = (step: Step, actions: string[]) =>
  typeof step.uses === 'string' &&
  actions.some((action) => (step.uses as string).toLowerCase().startsWith(`${action.toLowerCase()}@`));

const triggers = (on: unknown): string[] => {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((value): value is string => typeof value === 'string');
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
};

/** What a step deploys to, or `undefined` when it doesn't deploy. */
const stepChannel = (step: Step): Channel | undefined => {
  if (usesAction(step, [HOSTING_DEPLOY])) {
    const channel = step.with?.channelId;
    if (channel === 'live') return 'live';
    // An expression may resolve to `live`; anything else is a preview channel.
    return typeof channel === 'string' && isExpression(channel) && channel.includes('live') ? 'unknown' : 'preview';
  }
  if (usesAction(step, [FIREBASE_ACTION])) {
    const args = typeof step.with?.args === 'string' ? step.with.args : '';
    if (/^\s*hosting:channel:deploy\b/.test(args)) return 'preview';
    return /^\s*deploy\b/.test(args) ? 'live' : 'unknown';
  }
  if (typeof step.run !== 'string') return undefined;
  if (LIVE_COMMAND.test(step.run)) return 'live';
  return PREVIEW_COMMAND.test(step.run) ? 'preview' : undefined;
};

/** A job deploys live if any step does, so it gets the stricter environment. */
const jobChannel = (channels: Channel[]): Channel =>
  channels.includes('live') ? 'live' : channels.includes('unknown') ? 'unknown' : 'preview';

const environmentName = (environment: unknown): string | undefined => {
  const name = environment && typeof environment === 'object' ? (environment as { name?: unknown }).name : environment;
  return typeof name === 'string' && name ? name : undefined;
};

const environmentProblem = (channel: Channel, name: string | undefined, expected: ExpectedEnvironments) => {
  if (channel === 'unknown' || (name && isExpression(name))) return undefined;
  const { live, preview } = expected;
  if (channel === 'live') {
    if (!live || name === live.name) return undefined;
    return name
      ? `deploys live in \`${name}\`; use \`environment: ${live.name}\``
      : `deploys live without \`environment: ${live.name}\``;
  }
  const use = preview ? `; use \`environment: ${preview}\`` : '';
  if (live && live.branch !== false && name === live.name) {
    return `deploys to a preview channel in \`${name}\`, which only ${live.branch} can deploy to${use}`;
  }
  if (!preview || name === preview) return undefined;
  return name
    ? `deploys to a preview channel in \`${name}\`${use}`
    : `deploys to a preview channel without \`environment: ${preview}\``;
};

const grantsIdToken = (permissions: unknown) =>
  permissions === 'write-all' ||
  (typeof permissions === 'object' &&
    permissions !== null &&
    (permissions as Record<string, unknown>)['id-token'] === 'write');

/** Finds jobs that deploy to Firebase and checks they can mint OIDC tokens safely in the right environment. */
export const analyzeWorkflows = (
  workflows: Record<string, string>,
  environments: ExpectedEnvironments = {},
): WorkflowAnalysis => {
  const analysis: WorkflowAnalysis = {
    deployJobs: 0,
    previewJobs: 0,
    previewEnvironments: [],
    findings: [],
    writesCredentialsToWorkspace: false,
    parseErrors: [],
  };

  for (const [file, text] of Object.entries(workflows)) {
    let doc: { on?: unknown; permissions?: unknown; jobs?: Record<string, Job> } | null;
    try {
      doc = parse(text) as typeof doc;
    } catch {
      analysis.parseErrors.push(file);
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;

    const onPullRequest = triggers(doc.on).some((name) => name === 'pull_request' || name === 'pull_request_target');

    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      const steps = Array.isArray(job?.steps)
        ? (job.steps as Step[]).filter((step) => step && typeof step === 'object')
        : [];

      if (
        steps.some(
          (step) =>
            usesAction(step, ['google-github-actions/auth']) && String(step.with?.create_credentials_file) !== 'false',
        )
      ) {
        analysis.writesCredentialsToWorkspace = true;
      }

      const channels = steps.map(stepChannel).filter((channel) => channel !== undefined);
      if (!channels.length) continue;
      analysis.deployJobs += 1;
      const channel = jobChannel(channels);
      const environment = environmentName(job.environment);
      if (channel === 'preview') {
        analysis.previewJobs += 1;
        if (environment && !isExpression(environment) && !analysis.previewEnvironments.includes(environment)) {
          analysis.previewEnvironments.push(environment);
        }
      }

      const problems: string[] = [];
      if (!grantsIdToken(job.permissions ?? doc.permissions)) problems.push('missing `permissions: id-token: write`');
      if (onPullRequest && !(typeof job.if === 'string' && SAME_REPO_GUARD.test(job.if))) {
        problems.push('runs on pull_request without a same-repo guard, so fork PRs fail');
      }
      if (!steps.some((step) => usesAction(step, AUTH_ACTIONS))) {
        problems.push('does not use abraham/firebase-wif or google-github-actions/auth');
      }
      const environmentIssue = environmentProblem(channel, environment, environments);
      if (environmentIssue) problems.push(environmentIssue);
      if (problems.length) analysis.findings.push({ file, job: name, problems });
    }
  }
  return analysis;
};
