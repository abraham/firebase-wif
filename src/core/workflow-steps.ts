import { posix } from 'node:path';
import { parse } from 'yaml';

interface Defaults {
  run?: { 'working-directory'?: unknown };
}

export interface Step {
  uses?: unknown;
  run?: unknown;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  'working-directory'?: unknown;
}

export interface Job {
  if?: unknown;
  environment?: unknown;
  permissions?: unknown;
  steps?: unknown;
  env?: Record<string, unknown>;
  defaults?: Defaults;
}

interface Workflow {
  env?: Record<string, unknown>;
  defaults?: Defaults;
  jobs?: Record<string, Job>;
}

export type Channel = 'live' | 'preview' | 'unknown';

const HOSTING_DEPLOY = 'FirebaseExtended/action-hosting-deploy';
const FIREBASE_ACTION = 'w9jds/firebase-action';
const LIVE_COMMAND = /\bfirebase(?:-tools)?(?:@\S+)?\s+deploy\b/;
const PREVIEW_COMMAND = /\bfirebase(?:-tools)?(?:@\S+)?\s+hosting:channel:deploy\b/;

export const isExpression = (value: string) => value.includes('${{');

// GitHub resolves action owners and repos case-insensitively.
export const usesAction = (step: Step, actions: string[]) =>
  typeof step.uses === 'string' &&
  actions.some((action) => (step.uses as string).toLowerCase().startsWith(`${action.toLowerCase()}@`));

/** What a step deploys to, or `undefined` when it doesn't deploy. */
export const stepChannel = (step: Step): Channel | undefined => {
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

/** The directory a deploy step runs `firebase` in, or `undefined` when it can't be known statically. */
const stepDirectory = (step: Step, job: Job, doc: Workflow): string | undefined => {
  const directory = usesAction(step, [HOSTING_DEPLOY])
    ? step.with?.entryPoint
    : usesAction(step, [FIREBASE_ACTION])
      ? (step.env?.PROJECT_PATH ?? job.env?.PROJECT_PATH ?? doc.env?.PROJECT_PATH)
      : (step['working-directory'] ??
        job.defaults?.run?.['working-directory'] ??
        doc.defaults?.run?.['working-directory']);
  if (directory === undefined) return '.';
  if (typeof directory !== 'string' || isExpression(directory)) return undefined;
  return posix.normalize(directory.trim() || '.').replace(/\/$/, '') || '.';
};

/**
 * Directories that deploy steps run `firebase` in, relative to the repository root, like `.` or
 * `packages/server`, in file order without duplicates. Unparseable workflows and expressions are skipped.
 */
export const deployDirectories = (workflows: Record<string, string>): string[] => {
  const directories: string[] = [];
  for (const text of Object.values(workflows)) {
    let doc: Workflow | null;
    try {
      doc = parse(text) as Workflow | null;
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    for (const job of Object.values(doc.jobs ?? {})) {
      if (!job || !Array.isArray(job.steps)) continue;
      for (const step of job.steps as Step[]) {
        if (!step || typeof step !== 'object' || stepChannel(step) === undefined) continue;
        const directory = stepDirectory(step, job, doc);
        if (directory && !directories.includes(directory)) directories.push(directory);
      }
    }
  }
  return directories;
};
