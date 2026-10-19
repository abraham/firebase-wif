import {
  defaultComputeServiceAccount,
  defaultProviderId,
  defaultServiceAccountId,
  desiredAttributeCondition,
  desiredAttributeMapping,
  ISSUER,
  managedDescription,
  poolName,
  providerName,
  repoPrincipalSet,
  serviceAccountEmail,
} from '../core/naming.js';
import type { Binding } from '../core/policy.js';
import type { PresetName } from '../core/types.js';
import { apisFor, resolvePresets, rolesFor, SERVICE_ACCOUNT_USER_ROLE } from '../presets.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { createFakeGoogle, type FakeGoogle } from './fake-google.js';

export interface ConfiguredFakesOptions {
  projectId?: string;
  projectNumber?: string;
  repo?: string;
  repoId?: number;
  ownerId?: number;
  defaultBranch?: string;
  presets?: PresetName[];
  firebaseJson?: Record<string, unknown>;
}

export interface ConfiguredFakes {
  google: FakeGoogle;
  github: FakeGitHub;
  /** Pass to `status`/`plan`: `{ ...fakes.options, google: fakes.google, github: fakes.github }`. */
  options: { projectId: string; repo: string; presets: PresetName[] };
  names: { pool: string; provider: string; serviceAccount: string; principal: string };
}

/** Fakes for a repo and project that `status` reports as fully set up with the default names. */
export const createConfiguredFakes = ({
  projectId = 'demo-project',
  projectNumber = '123456789012',
  repo = 'octo-org/site',
  repoId = 987654321,
  ownerId = 1234567,
  defaultBranch = 'main',
  presets,
  firebaseJson,
}: ConfiguredFakesOptions = {}): ConfiguredFakes => {
  const resolvedPresets = presets ?? resolvePresets(firebaseJson);
  const pool = poolName(projectNumber, 'github');
  const provider = providerName(projectNumber, 'github', defaultProviderId(repoId));
  const serviceAccount = serviceAccountEmail(defaultServiceAccountId(repoId), projectId);
  const principal = repoPrincipalSet(projectNumber, 'github', repoId);
  const member = `serviceAccount:${serviceAccount}`;
  const bindings: Binding[] = rolesFor({ presets: resolvedPresets }).map((role) => ({ role, members: [member] }));

  const google = createFakeGoogle({
    projects: [
      {
        projectId,
        projectNumber,
        enabledServices: apisFor(resolvedPresets),
        iamPolicy: { version: 1, etag: 'BwX1', bindings },
      },
    ],
    pools: { [pool]: { state: 'ACTIVE' } },
    providers: {
      [provider]: {
        state: 'ACTIVE',
        attributeMapping: desiredAttributeMapping(),
        attributeCondition: desiredAttributeCondition(repoId, ownerId),
        oidc: { issuerUri: ISSUER },
      },
    },
    serviceAccounts: {
      [serviceAccount]: {
        projectId,
        description: managedDescription(repo, repoId),
        iamPolicy: { etag: 'BwX1', bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [principal] }] },
      },
      ...(resolvedPresets.includes('functions')
        ? {
            [defaultComputeServiceAccount(projectNumber)]: {
              projectId,
              iamPolicy: { etag: 'BwX1', bindings: [{ role: SERVICE_ACCOUNT_USER_ROLE, members: [member] }] },
            },
          }
        : {}),
    },
  });

  const github = createFakeGitHub({
    repos: {
      [repo]: {
        id: repoId,
        owner: { id: ownerId, login: repo.split('/')[0]! },
        default_branch: defaultBranch,
        permissions: { admin: true },
        variables: { FIREBASE_WIF_PROVIDER: provider, FIREBASE_WIF_SERVICE_ACCOUNT: serviceAccount },
        environments: {
          production: {
            deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
            branchPolicies: [defaultBranch],
          },
        },
      },
    },
  });

  return {
    google,
    github,
    options: { projectId, repo, presets: resolvedPresets },
    names: { pool, provider, serviceAccount, principal },
  };
};
