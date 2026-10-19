import { describe, expect, it } from 'vitest';
import { FirebaseWifError } from '../../src/core/errors.js';
import {
  defaultComputeServiceAccount,
  defaultProviderId,
  defaultServiceAccountId,
  desiredAttributeCondition,
  desiredAttributeMapping,
  managedDescription,
  MANAGED_MARKER,
  parseProviderName,
  poolName,
  providerName,
  repoPrincipalSet,
  REQUIRED_MAPPING_KEYS,
  serviceAccountEmail,
  serviceAccountProject,
  validatePoolOrProvider,
  validateProjectId,
  validateRepo,
  validateRole,
  validateServiceAccountEmail,
  validateVariableName,
} from '../../src/core/naming.js';

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FirebaseWifError && error.code === 'INVALID_NAME';
  }
  return false;
};

describe('validators', () => {
  it('validates project IDs', () => {
    expect(validateProjectId('demo-project')).toBe('demo-project');
    for (const bad of ['Demo-project', 'abc', '1project', 'project-', 'a'.repeat(31)]) expect(invalid(() => validateProjectId(bad)), bad).toBe(true);
  });

  it('validates repositories', () => {
    expect(validateRepo('abraham/abrah.am')).toBe('abraham/abrah.am');
    for (const bad of ['abraham', 'a/b/c', 'a/b; rm -rf /', '../x']) expect(invalid(() => validateRepo(bad)), bad).toBe(true);
  });

  it('validates pool and provider IDs', () => {
    expect(validatePoolOrProvider('provider', 'github-123456789')).toBe('github-123456789');
    for (const bad of ['gcp-pool', 'abc', 'a'.repeat(33), 'Upper-case']) {
      expect(invalid(() => validatePoolOrProvider('pool', bad)), bad).toBe(true);
    }
  });

  it('validates roles', () => {
    expect(validateRole('roles/firebasehosting.admin')).toBe('roles/firebasehosting.admin');
    expect(validateRole('projects/demo-project/roles/deployer')).toBe('projects/demo-project/roles/deployer');
    expect(validateRole('organizations/123/roles/deployer')).toBe('organizations/123/roles/deployer');
    expect(invalid(() => validateRole('firebasehosting.admin'))).toBe(true);
  });

  it('validates service account emails and variable names', () => {
    expect(validateServiceAccountEmail('123-compute@developer.gserviceaccount.com')).toBe('123-compute@developer.gserviceaccount.com');
    expect(invalid(() => validateServiceAccountEmail('someone@example.com'))).toBe(true);
    expect(validateVariableName('FIREBASE_WIF_PROVIDER')).toBe('FIREBASE_WIF_PROVIDER');
    for (const bad of ['GITHUB_TOKEN', 'BAD-NAME', '1NAME']) expect(invalid(() => validateVariableName(bad)), bad).toBe(true);
  });
});

describe('service accounts', () => {
  it('accepts IDs or emails', () => {
    expect(serviceAccountEmail('github-deploy', 'demo-project')).toBe('github-deploy@demo-project.iam.gserviceaccount.com');
    expect(serviceAccountEmail('x-y-z1@other-proj.iam.gserviceaccount.com', 'demo-project')).toBe('x-y-z1@other-proj.iam.gserviceaccount.com');
    expect(invalid(() => serviceAccountEmail('ab', 'demo-project'))).toBe(true);
  });

  it('finds the owning project of user-managed accounts', () => {
    expect(serviceAccountProject('github-deploy@demo-project.iam.gserviceaccount.com')).toBe('demo-project');
    expect(serviceAccountProject('123-compute@developer.gserviceaccount.com')).toBeUndefined();
  });

  it('names defaults after the repository ID', () => {
    expect(defaultProviderId(42)).toBe('github-42');
    expect(defaultServiceAccountId(42)).toBe('github-42');
    expect(defaultComputeServiceAccount('123')).toBe('123-compute@developer.gserviceaccount.com');
    expect(managedDescription('o/r', 42)).toBe(`${MANAGED_MARKER} for o/r (42)`);
  });
});

describe('resource names', () => {
  it('builds and parses provider names', () => {
    expect(poolName('123', 'github')).toBe('projects/123/locations/global/workloadIdentityPools/github');
    const name = providerName('123', 'github', 'github-42');
    expect(name).toBe('projects/123/locations/global/workloadIdentityPools/github/providers/github-42');
    expect(parseProviderName(name)).toEqual({ projectNumber: '123', pool: 'github', provider: 'github-42' });
    expect(parseProviderName('projects/demo/locations/global/workloadIdentityPools/github/providers/x-y-z')).toBeUndefined();
    expect(parseProviderName('')).toBeUndefined();
  });

  it('builds the repository principal set', () => {
    expect(repoPrincipalSet('123', 'github', 42)).toBe(
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/github/attribute.repository_id/42',
    );
  });
});

describe('provider configuration', () => {
  it('pins the repository and owner IDs', () => {
    expect(desiredAttributeCondition(42, 7)).toBe("assertion.repository_id == '42' && assertion.repository_owner_id == '7'");
  });

  it('maps every required attribute', () => {
    const mapping = desiredAttributeMapping();
    for (const key of REQUIRED_MAPPING_KEYS) expect(mapping[key]).toBeDefined();
    expect(mapping['attribute.repository_id']).toBe('assertion.repository_id');
  });
});
