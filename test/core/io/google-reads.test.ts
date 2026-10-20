import { describe, expect, it } from 'vitest';
import {
  readPool,
  readProjectPolicy,
  readProvider,
  readServiceAccount,
  readServiceAccountKeys,
  readServiceAccountPolicy,
  readServices,
} from '../../../src/core/io/google-reads.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { runtimeFor } from '../../helpers.js';

describe('readers', () => {
  it('batch-reads services by project number', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.enabledServices = ['iam.googleapis.com'];

    const services = await readServices(rt);
    expect(services.kind === 'found' && Object.fromEntries(services.value)).toEqual({
      'cloudresourcemanager.googleapis.com': false,
      'firebasehosting.googleapis.com': false,
      'iam.googleapis.com': true,
      'iamcredentials.googleapis.com': false,
      'sts.googleapis.com': false,
    });
    expect(fakes.google.calls).toHaveLength(1);
    expect(fakes.google.calls[0]!.url).toMatch(
      /^https:\/\/serviceusage\.googleapis\.com\/v1\/projects\/123456789012\/services:batchGet\?names=/,
    );
    await readServices(rt);
    expect(fakes.google.calls).toHaveLength(1);
  });

  it('reads IAM resources', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    expect(await readPool(rt)).toMatchObject({ kind: 'found', value: { state: 'ACTIVE' } });
    expect(await readProvider(rt)).toMatchObject({
      kind: 'found',
      value: { oidc: { issuerUri: 'https://token.actions.githubusercontent.com' } },
    });
    expect(await readServiceAccount(rt)).toMatchObject({ kind: 'found', value: { email: fakes.names.serviceAccount } });
    expect(await readServiceAccountKeys(rt)).toEqual({ kind: 'found', value: [] });
    expect(await readServiceAccountPolicy(rt, fakes.names.serviceAccount)).toMatchObject({ kind: 'found' });
    expect(fakes.google.calls.map((c) => `${c.method} ${c.url.replace(/\?.*/, '')}`)).toContain(
      `POST https://iam.googleapis.com/v1/projects/-/serviceAccounts/${fakes.names.serviceAccount}:getIamPolicy`,
    );
  });

  it('reports IAM reads as blocked while the IAM API is off', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.enabledServices = [];
    expect(await readPool(rt)).toEqual({
      kind: 'skipped',
      reason: 'blocked by gcp.apis (iam.googleapis.com is disabled)',
    });
    expect(await readServiceAccount(rt)).toMatchObject({ kind: 'skipped' });
    expect(fakes.google.calls.every((c) => c.url.includes('serviceusage'))).toBe(true);
  });

  it('reads the project policy as version 3', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    expect(await readProjectPolicy(rt)).toMatchObject({
      kind: 'found',
      value: { bindings: [{ role: 'roles/firebasehosting.admin' }] },
    });
    expect(fakes.google.calls[0]).toEqual({
      method: 'POST',
      url: 'https://cloudresourcemanager.googleapis.com/v1/projects/demo-project:getIamPolicy',
      body: { options: { requestedPolicyVersion: 3 } },
    });
  });
});
