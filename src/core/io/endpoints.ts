import type { Context } from '../types.js';

export const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
export const IAM = 'https://iam.googleapis.com/v1';
export const SERVICE_USAGE = 'https://serviceusage.googleapis.com/v1';

export const poolId = (ctx: Context): string => ctx.pool.split('/').pop()!;
export const providerId = (ctx: Context): string => ctx.provider.split('/').pop()!;

/** The principal set for this repository in the pool, which may live in the home project. */
export const repoPrincipal = (ctx: Context): string =>
  `principalSet://iam.googleapis.com/${ctx.pool}/attribute.repository_id/${ctx.repoId}`;
