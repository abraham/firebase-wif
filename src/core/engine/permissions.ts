import { FirebaseWifError, isAbortError } from '../errors.js';
import { CRM } from '../io/endpoints.js';
import type { RepoResource } from '../io/reads.js';
import type { Change, Context, GoogleClient, Preflight } from '../types.js';
import { isCrossProject } from './chain.js';

/** Everything `setup` calls, so a preflight can say exactly what the operator lacks. */
export const SETUP_PERMISSIONS: readonly string[] = [
  'iam.serviceAccounts.create',
  'iam.serviceAccounts.setIamPolicy',
  'iam.workloadIdentityPools.create',
  'iam.workloadIdentityPools.undelete',
  'iam.workloadIdentityPoolProviders.create',
  'iam.workloadIdentityPoolProviders.update',
  'iam.workloadIdentityPoolProviders.undelete',
  'resourcemanager.projects.setIamPolicy',
  'serviceusage.services.enable',
];

/** What `setup` calls in a project that reuses another project's trust chain (docs/multi-project.md). */
export const CROSS_PROJECT_PERMISSIONS: readonly string[] = [
  'iam.serviceAccounts.setIamPolicy',
  'resourcemanager.projects.setIamPolicy',
  'serviceusage.services.enable',
];

export const runPreflight = async (
  google: GoogleClient,
  ctx: Context,
  repo: RepoResource,
  github: boolean,
): Promise<Preflight> => {
  const needed = isCrossProject(ctx) ? CROSS_PROJECT_PERMISSIONS : SETUP_PERMISSIONS;
  let granted: string[] = [];
  try {
    ({ permissions: granted = [] } = await google.request<{ permissions?: string[] }>(
      'POST',
      `${CRM}/projects/${ctx.projectId}:testIamPermissions`,
      { permissions: needed },
    ));
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  return {
    missingPermissions: needed.filter((permission) => !granted.includes(permission)),
    githubAdmin: github ? Boolean(repo.permissions?.admin) : undefined,
  };
};

/** Throws `MISSING_PERMISSIONS` when the plan writes to Google Cloud and the preflight found gaps. */
export const assertCanApply = (changes: Change[], preflight: Preflight) => {
  const { missingPermissions } = preflight;
  if (!missingPermissions.length || !changes.some((c) => !c.manual && c.resource.startsWith('gcp.'))) return;
  throw new FirebaseWifError(
    'MISSING_PERMISSIONS',
    `You're missing permissions that setup needs: ${missingPermissions.join(', ')}.`,
    {
      fix: 'Ask a project owner to run firebase-wif setup.',
      details: { missingPermissions },
    },
  );
};
