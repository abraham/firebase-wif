import type { ResourceId } from '../types.js';
import { apis } from './apis.js';
import { environment } from './environment.js';
import { pool } from './pool.js';
import { projectRoles } from './project-roles.js';
import { providerCondition } from './provider-condition.js';
import { provider } from './provider.js';
import type { Resource } from './resource.js';
import { runtimeServiceAccountUser } from './runtime-sa-user.js';
import { serviceAccount } from './service-account.js';
import { variables } from './variables.js';
import { workloadIdentityUser } from './workload-identity-user.js';

/** In the order `setup` applies them. */
export const RESOURCES: readonly Resource[] = [
  apis,
  pool,
  provider,
  providerCondition,
  serviceAccount,
  projectRoles,
  workloadIdentityUser,
  runtimeServiceAccountUser,
  variables,
  environment,
];

export const resourceById = (id: ResourceId): Resource => {
  const resource = RESOURCES.find((r) => r.id === id);
  if (!resource) throw new Error(`Unknown resource ${id}`);
  return resource;
};
