import { describe, expect, it } from 'vitest';
import { estimateSub, GOOGLE_SUBJECT_MAX_BYTES } from '../../src/core/oidc.js';

const params = { repo: 'octo-org/site', repoId: 42, ownerId: 7, branch: 'main', environment: 'production' };

describe('estimateSub', () => {
  it('uses the default template', () => {
    expect(estimateSub({ useDefault: true, includeClaimKeys: [] }, params)).toEqual({
      longest: 'repo:octo-org/site:environment:production',
      bytes: 41,
    });
  });

  it('treats an empty claim list as the default template', () => {
    expect(estimateSub({ useDefault: false, includeClaimKeys: [] }, params).longest).toBe('repo:octo-org/site:environment:production');
  });

  it('considers branch and pull request jobs without an environment', () => {
    expect(estimateSub({ useDefault: true, includeClaimKeys: [] }, { ...params, environment: undefined }).longest).toBe(
      'repo:octo-org/site:ref:refs/heads/main',
    );
  });

  it('renders customized claims', () => {
    const estimate = estimateSub({ useDefault: false, includeClaimKeys: ['repo', 'context', 'repository_id'] }, params);
    expect(estimate.longest).toBe('repo:octo-org/site:environment:production:repository_id:42');
  });

  it('renders every known claim', () => {
    const estimate = estimateSub(
      {
        useDefault: false,
        includeClaimKeys: ['repository_owner', 'repository_owner_id', 'ref', 'environment', 'job_workflow_ref'],
      },
      params,
    );
    expect(estimate.longest).toBe(
      'repository_owner:octo-org:repository_owner_id:7:ref:refs/heads/main:environment:production:job_workflow_ref:octo-org/site/.github/workflows/deploy.yml@refs/heads/main',
    );
  });

  it('estimates unknown claims with a placeholder', () => {
    expect(estimateSub({ useDefault: false, includeClaimKeys: ['actor'] }, params).longest).toBe(`actor:${'x'.repeat(40)}`);
  });

  it('counts bytes, not characters', () => {
    const estimate = estimateSub({ useDefault: true, includeClaimKeys: [] }, { ...params, environment: 'production-é' });
    expect(estimate.longest).toBe('repo:octo-org/site:environment:production-é');
    expect(estimate.bytes).toBe(estimate.longest.length + 1);
  });

  it('notices long branch names', () => {
    const estimate = estimateSub({ useDefault: true, includeClaimKeys: [] }, { ...params, branch: 'b'.repeat(120) });
    expect(estimate.bytes).toBeGreaterThan(GOOGLE_SUBJECT_MAX_BYTES);
  });
});
