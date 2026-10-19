import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/testing/fake-github.js';

const fake = () =>
  createFakeGitHub({
    repos: {
      'o/r': {
        id: 42,
        owner: { id: 7, login: 'o' },
        default_branch: 'main',
        variables: { A: '1' },
        secrets: ['S'],
        environments: { production: { deployment_branch_policy: null, branchPolicies: [] } },
      },
    },
  });

describe('createFakeGitHub', () => {
  it('serves the repository with admin permissions by default', async () => {
    expect(await fake().request('GET', '/repos/o/r')).toEqual({
      id: 42,
      owner: { id: 7, login: 'o' },
      default_branch: 'main',
      permissions: { admin: true },
    });
    await expect(fake().request('GET', '/repos/o/missing')).rejects.toMatchObject({ status: 404 });
  });

  it('reads, creates, and updates variables', async () => {
    const github = fake();
    expect(await github.request('GET', '/repos/o/r/actions/variables?per_page=30')).toEqual({
      total_count: 1,
      variables: [{ name: 'A', value: '1' }],
    });
    expect(await github.request('GET', '/repos/o/r/actions/variables/A')).toEqual({ name: 'A', value: '1' });
    await expect(github.request('GET', '/repos/o/r/actions/variables/B')).rejects.toMatchObject({ status: 404 });
    await github.request('POST', '/repos/o/r/actions/variables', { name: 'B', value: '2' });
    await expect(github.request('POST', '/repos/o/r/actions/variables', { name: 'B', value: '3' })).rejects.toMatchObject({ status: 409 });
    await github.request('PATCH', '/repos/o/r/actions/variables/A', { name: 'A', value: '9' });
    expect(github.state.repos['o/r']!.variables).toEqual({ A: '9', B: '2' });
  });

  it('lists secrets and the OIDC sub template, ignoring query strings', async () => {
    const github = fake();
    expect(await github.request('GET', '/repos/o/r/actions/secrets?per_page=100')).toEqual({ total_count: 1, secrets: [{ name: 'S' }] });
    expect(await github.request('GET', '/repos/o/r/actions/oidc/customization/sub')).toEqual({ use_default: true });
  });

  it('reads and writes environments and branch policies', async () => {
    const github = fake();
    expect(await github.request('GET', '/repos/o/r/environments/production')).toEqual({
      name: 'production',
      deployment_branch_policy: null,
      protection_rules: [],
    });
    await github.request('PUT', '/repos/o/r/environments/production', {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    await github.request('POST', '/repos/o/r/environments/production/deployment-branch-policies', { name: 'main' });
    expect(await github.request('GET', '/repos/o/r/environments/production/deployment-branch-policies')).toEqual({
      total_count: 1,
      branch_policies: [{ name: 'main', type: 'branch' }],
    });
    await github.request('PUT', '/repos/o/r/environments/staging%20env', {});
    expect(github.state.repos['o/r']!.environments!['staging env']).toEqual({ deployment_branch_policy: null, branchPolicies: [] });
    await expect(github.request('GET', '/repos/o/r/environments/missing')).rejects.toMatchObject({ status: 404 });
    await expect(github.request('GET', '/repos/o/r/environments/missing/deployment-branch-policies')).rejects.toMatchObject({ status: 404 });
  });

  it('reports protection rules and replaces the ones a PUT leaves out', async () => {
    const github = fake();
    Object.assign(github.state.repos['o/r']!.environments!.production!, {
      waitTimer: 30,
      reviewers: [{ type: 'Team', id: 9 }],
      preventSelfReview: true,
    });
    expect(await github.request('GET', '/repos/o/r/environments/production')).toMatchObject({
      protection_rules: [
        { type: 'wait_timer', wait_timer: 30 },
        { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'Team', reviewer: { id: 9 } }] },
      ],
    });
    await github.request('PUT', '/repos/o/r/environments/production', { wait_timer: 5 });
    expect(github.state.repos['o/r']!.environments!.production).toEqual({ deployment_branch_policy: null, branchPolicies: [], waitTimer: 5 });
  });

  it('answers 403 for forbidden paths and records calls', async () => {
    const github = fake();
    github.state.forbidden = ['/secrets'];
    await expect(github.request('GET', '/repos/o/r/actions/secrets')).rejects.toMatchObject({ status: 403 });
    await expect(github.request('DELETE', '/repos/o/r')).rejects.toMatchObject({ status: 404 });
    expect(github.calls).toEqual([
      { method: 'GET', url: '/repos/o/r/actions/secrets' },
      { method: 'DELETE', url: '/repos/o/r' },
    ]);
  });
});
