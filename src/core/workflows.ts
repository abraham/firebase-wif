import { parse } from 'yaml';

export interface WorkflowFinding {
  file: string;
  job: string;
  problems: string[];
}

export interface WorkflowAnalysis {
  deployJobs: number;
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
  permissions?: unknown;
  steps?: unknown;
}

const DEPLOY_ACTIONS = ['FirebaseExtended/action-hosting-deploy', 'w9jds/firebase-action'];
const AUTH_ACTIONS = ['abraham/firebase-wif', 'google-github-actions/auth'];
const DEPLOY_COMMAND = /\bfirebase(?:-tools)?(?:@\S+)?\s+(?:deploy|hosting:channel:deploy)\b/;
const SAME_REPO_GUARD = /head\.repo\.(?:full_name|fork)/;

const usesAction = (step: Step, actions: string[]) =>
  typeof step.uses === 'string' && actions.some((action) => (step.uses as string).startsWith(`${action}@`));

const triggers = (on: unknown): string[] => {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((value): value is string => typeof value === 'string');
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
};

const grantsIdToken = (permissions: unknown) =>
  permissions === 'write-all' ||
  (typeof permissions === 'object' && permissions !== null && (permissions as Record<string, unknown>)['id-token'] === 'write');

/** Finds jobs that deploy to Firebase and checks they can mint OIDC tokens safely. */
export const analyzeWorkflows = (workflows: Record<string, string>): WorkflowAnalysis => {
  const analysis: WorkflowAnalysis = { deployJobs: 0, findings: [], writesCredentialsToWorkspace: false, parseErrors: [] };

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
      const steps = Array.isArray(job?.steps) ? (job.steps as Step[]).filter((step) => step && typeof step === 'object') : [];

      if (steps.some((step) => usesAction(step, ['google-github-actions/auth']) && String(step.with?.create_credentials_file) !== 'false')) {
        analysis.writesCredentialsToWorkspace = true;
      }

      const deploys = steps.some(
        (step) => usesAction(step, DEPLOY_ACTIONS) || (typeof step.run === 'string' && DEPLOY_COMMAND.test(step.run)),
      );
      if (!deploys) continue;
      analysis.deployJobs += 1;

      const problems: string[] = [];
      if (!grantsIdToken(job.permissions ?? doc.permissions)) problems.push('missing `permissions: id-token: write`');
      if (onPullRequest && !(typeof job.if === 'string' && SAME_REPO_GUARD.test(job.if))) {
        problems.push('runs on pull_request without a same-repo guard, so fork PRs fail');
      }
      if (!steps.some((step) => usesAction(step, AUTH_ACTIONS))) {
        problems.push('does not use abraham/firebase-wif or google-github-actions/auth');
      }
      if (problems.length) analysis.findings.push({ file, job: name, problems });
    }
  }
  return analysis;
};
