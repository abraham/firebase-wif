import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/core/errors.js';
import {
  createMemo,
  read,
  readPool,
  readProjectPolicy,
  readProvider,
  readServiceAccount,
  readServiceAccountKeys,
  readServiceAccountPolicy,
  readServices,
  poolId,
  providerId,
} from '../../src/core/runtime.js';
import { createConfiguredFakes } from '../../src/testing/index.js';
import { runtimeFor } from '../helpers.js';

describe('read', () => {
  it('turns responses into found, missing, or skipped', async () => {
    expect(await read(async () => 1)).toEqual({ kind: 'found', value: 1 });
    expect(await read(() => Promise.reject(new HttpError(404, 'gone')))).toEqual({ kind: 'missing' });
    expect(await read(() => Promise.reject(new HttpError(403, 'denied')))).toEqual({
      kind: 'skipped',
      reason: 'insufficient permission (denied)',
    });
    expect(await read(() => Promise.reject(new HttpError(500, 'boom')))).toEqual({
      kind: 'skipped',
      reason: 'request failed (500): boom',
    });
    expect(await read(() => Promise.reject('weird'))).toEqual({
      kind: 'skipped',
      reason: 'request failed: unknown error',
    });
  });

  it('truncates long messages', async () => {
    const result = await read(() => Promise.reject(new HttpError(500, 'x'.repeat(500))));
    expect(result.kind === 'skipped' && result.reason.length).toBeLessThan(240);
  });

  it('rethrows aborts', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await expect(read(() => Promise.reject(abort))).rejects.toBe(abort);
  });
});

describe('createMemo', () => {
  it('loads each key once', async () => {
    const memo = createMemo();
    const load = vi.fn(async () => 'value');
    expect(await Promise.all([memo('a', load), memo('a', load)])).toEqual(['value', 'value']);
    await memo('b', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

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

  it('extracts IDs from full resource names', async () => {
    const rt = await runtimeFor();
    expect(poolId(rt.ctx)).toBe('github');
    expect(providerId(rt.ctx)).toBe('github-987654321');
  });
});
