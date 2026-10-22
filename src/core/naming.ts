import { FirebaseWifError } from './errors.js';

export const DEFAULT_POOL = 'github';
export const DEFAULT_VARIABLE_PREFIX = 'FIREBASE_WIF_';
export const DEFAULT_ENVIRONMENT = 'production';
export const DEFAULT_PREVIEW_ENVIRONMENT = 'preview';

/** The default names that don't depend on the repository. */
export const DEFAULTS = {
  pool: DEFAULT_POOL,
  environment: DEFAULT_ENVIRONMENT,
  previewEnvironment: DEFAULT_PREVIEW_ENVIRONMENT,
  variablePrefix: DEFAULT_VARIABLE_PREFIX,
} as const;
export const ISSUER = 'https://token.actions.githubusercontent.com';
export const MANAGED_MARKER = 'Managed by firebase-wif';

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// Pool and provider IDs: 4-32 chars, lowercase letters, digits, and hyphens; `gcp-` is reserved.
const POOL_OR_PROVIDER = /^(?!gcp-)[a-z0-9-]{4,32}$/;
const ACCOUNT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SA_EMAIL = /^([a-z][a-z0-9-]{4,28}[a-z0-9])@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const ANY_SA_EMAIL = /^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/;
const ROLE =
  /^(roles\/[A-Za-z0-9_.]+|projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/roles\/[A-Za-z0-9_.]+|organizations\/\d+\/roles\/[A-Za-z0-9_.]+)$/;
const PROVIDER_NAME =
  /^projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([a-z0-9-]{4,32})\/providers\/([a-z0-9-]{4,32})$/;

const invalid = (what: string, value: string, rule: string): never => {
  throw new FirebaseWifError('INVALID_NAME', `Invalid ${what} "${value}": ${rule}.`);
};

export const validateProjectId = (value: string): string =>
  PROJECT_ID.test(value) ? value : invalid('project ID', value, '6-30 lowercase letters, digits, or hyphens');

export const validateRepo = (value: string): string =>
  REPO.test(value) ? value : invalid('repository', value, 'expected owner/name');

export const validatePoolOrProvider = (kind: 'pool' | 'provider', value: string): string =>
  POOL_OR_PROVIDER.test(value)
    ? value
    : invalid(`${kind} ID`, value, '4-32 lowercase letters, digits, or hyphens, not starting with gcp-');

export const validateRole = (value: string): string =>
  ROLE.test(value) ? value : invalid('role', value, 'expected roles/NAME or a custom role resource name');

export const validateServiceAccountEmail = (value: string): string =>
  ANY_SA_EMAIL.test(value)
    ? value
    : invalid('service account', value, 'expected an email ending in .gserviceaccount.com');

export const validateVariableName = (value: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !/^GITHUB_/i.test(value)
    ? value
    : invalid('variable name', value, 'letters, digits, and underscores, not starting with GITHUB_');

/** Accepts an account ID or a full email; returns the email. */
export const serviceAccountEmail = (idOrEmail: string, projectId: string): string => {
  if (idOrEmail.includes('@')) return validateServiceAccountEmail(idOrEmail);
  if (!ACCOUNT_ID.test(idOrEmail))
    invalid('service account ID', idOrEmail, '6-30 lowercase letters, digits, or hyphens');
  return `${idOrEmail}@${projectId}.iam.gserviceaccount.com`;
};

/** The project ID that owns a user-managed SA email, if it has the standard form. */
export const serviceAccountProject = (email: string): string | undefined => SA_EMAIL.exec(email)?.[2];

export const defaultProviderId = (repoId: number): string => `github-${repoId}`;
export const defaultServiceAccountId = (repoId: number): string => `github-${repoId}`;

export const poolName = (projectNumber: string, pool: string): string =>
  `projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}`;

export const providerName = (projectNumber: string, pool: string, provider: string): string =>
  `${poolName(projectNumber, pool)}/providers/${provider}`;

export const parseProviderName = (
  name: string,
): { projectNumber: string; pool: string; provider: string } | undefined => {
  const match = PROVIDER_NAME.exec(name);
  return match ? { projectNumber: match[1]!, pool: match[2]!, provider: match[3]! } : undefined;
};

export const repoPrincipalSet = (projectNumber: string, pool: string, repoId: number): string =>
  `principalSet://iam.googleapis.com/${poolName(projectNumber, pool)}/attribute.repository_id/${repoId}`;

export const defaultComputeServiceAccount = (projectNumber: string): string =>
  `${projectNumber}-compute@developer.gserviceaccount.com`;

export const defaultAppEngineServiceAccount = (projectId: string): string => `${projectId}@appspot.gserviceaccount.com`;

const ROLE_LABELS: Record<string, string> = {
  'roles/cloudfunctions.admin': 'Cloud Functions admin',
  'roles/datastore.indexAdmin': 'Firestore index admin',
  'roles/firebasehosting.admin': 'Firebase Hosting admin',
  'roles/firebaserules.admin': 'Firebase Rules admin',
  'roles/firebasestorage.viewer': 'Cloud Storage for Firebase viewer',
  'roles/serviceusage.serviceUsageConsumer': 'Service Usage consumer',
  'roles/storage.bucketViewer': 'Storage bucket viewer',
};

/** A plain-language name for a role, like `Firestore index admin` for `roles/datastore.indexAdmin`. */
export const roleLabel = (role: string): string => {
  const known = ROLE_LABELS[role];
  if (known) return known;
  return role
    .split('/')
    .pop()!
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._]/g, ' ')
    .toLowerCase();
};

/** A plain-language name for a functions runtime service account. */
export const runtimeLabel = (email: string, ctx: { projectId: string; projectNumber: string }): string => {
  if (email === defaultComputeServiceAccount(ctx.projectNumber)) return 'the default compute account';
  if (email === defaultAppEngineServiceAccount(ctx.projectId)) return 'the App Engine default account';
  return `the ${email.split('@')[0]} account`;
};

export const managedDescription = (repo: string, repoId: number): string => `${MANAGED_MARKER} for ${repo} (${repoId})`;

export const desiredAttributeMapping = (): Record<string, string> => ({
  'google.subject': 'assertion.sub',
  'attribute.repository': 'assertion.repository',
  'attribute.repository_id': 'assertion.repository_id',
  'attribute.repository_owner_id': 'assertion.repository_owner_id',
  'attribute.ref': 'assertion.ref',
  'attribute.environment': 'assertion.environment',
});

export const desiredAttributeCondition = (repoId: number, ownerId: number): string =>
  `assertion.repository_id == '${repoId}' && assertion.repository_owner_id == '${ownerId}'`;

/** Attribute mappings that trust and auditing depend on; others may differ. */
export const REQUIRED_MAPPING_KEYS = ['google.subject', 'attribute.repository_id'] as const;
