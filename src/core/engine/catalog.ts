import { GCP_ADVISORIES } from '../checks/gcp.js';
import { GITHUB_ADVISORIES } from '../checks/github.js';
import { LOCAL_CHECKS } from '../checks/local.js';
import type { Advisory } from '../checks/advisory.js';
import { resourceById } from '../resources/registry.js';
import type { Resource } from '../resources/resource.js';
import type { Context, ResourceId } from '../types.js';

export type Entry = { resource: Resource } | { advisory: Advisory };

/** Every check in report order (docs/checks.md), interleaving resources and advisories. */
export const entries = (ctx: Context): Entry[] => {
  const resource = (id: ResourceId): Entry => ({ resource: resourceById(id) });
  const advisory = (value: Advisory): Entry => ({ advisory: value });
  return [
    ...LOCAL_CHECKS.map(advisory),
    advisory(GCP_ADVISORIES.project),
    advisory(GCP_ADVISORIES.operator),
    resource('gcp.apis'),
    resource('gcp.pool'),
    resource('gcp.provider'),
    resource('gcp.provider-condition'),
    resource('gcp.service-account'),
    advisory(GCP_ADVISORIES.serviceAccountKeys),
    resource('gcp.project-roles'),
    advisory(GCP_ADVISORIES.extraRoles),
    resource('gcp.wi-user'),
    advisory(GCP_ADVISORIES.broadImpersonation),
    ...(ctx.runtimeServiceAccounts.length ? [resource('gcp.runtime-sa-user')] : []),
    advisory(GITHUB_ADVISORIES.repo),
    resource('gh.variables'),
    resource('gh.environment'),
    advisory(GITHUB_ADVISORIES.legacySecrets),
    advisory(GITHUB_ADVISORIES.oidcSub),
    advisory(GITHUB_ADVISORIES.workflows),
  ];
};
