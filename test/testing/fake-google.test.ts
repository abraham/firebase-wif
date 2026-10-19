import { describe, expect, it } from 'vitest';
import { createFakeGoogle } from '../../src/testing/fake-google.js';

const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
const IAM = 'https://iam.googleapis.com/v1';
const SU = 'https://serviceusage.googleapis.com/v1';
const POOL = 'projects/123/locations/global/workloadIdentityPools/github';

const fake = () =>
  createFakeGoogle({
    projects: [{ projectId: 'demo-project', projectNumber: '123', enabledServices: ['iam.googleapis.com'], iamPolicy: { bindings: [] } }],
    pools: { [POOL]: {} },
    providers: { [`${POOL}/providers/gh`]: { attributeCondition: 'x' } },
    serviceAccounts: { 'sa@demo-project.iam.gserviceaccount.com': { projectId: 'demo-project', keys: ['k1'] } },
  });

describe('createFakeGoogle', () => {
  it('copies the seed so tests do not share state', () => {
    const seed = { projects: [{ projectId: 'p-123456', projectNumber: '1', enabledServices: [], iamPolicy: {} }] };
    const google = createFakeGoogle(seed);
    google.state.projects[0]!.enabledServices.push('x');
    expect(seed.projects[0]!.enabledServices).toEqual([]);
    expect(createFakeGoogle().state).toEqual({ projects: [], pools: {}, providers: {}, serviceAccounts: {}, forbidden: [] });
  });

  it('serves projects by ID or number', async () => {
    const google = fake();
    expect(await google.request('GET', `${CRM}/projects/demo-project`)).toEqual({ projectId: 'demo-project', projectNumber: '123', lifecycleState: 'ACTIVE' });
    expect(await google.request('GET', `${CRM}/projects/123`)).toMatchObject({ projectId: 'demo-project' });
    await expect(google.request('GET', `${CRM}/projects/missing`)).rejects.toMatchObject({ status: 404 });
  });

  it('reads and writes project policies with etags', async () => {
    const google = fake();
    const policy = await google.request<{ etag: string; version: number }>('POST', `${CRM}/projects/demo-project:getIamPolicy`, {});
    expect(policy).toEqual({ version: 1, etag: 'BwX0', bindings: [] });

    const bindings = [{ role: 'roles/viewer', members: ['user:a@example.com'] }];
    const updated = await google.request<{ etag: string }>('POST', `${CRM}/projects/demo-project:setIamPolicy`, { policy: { ...policy, bindings } });
    expect(updated).toMatchObject({ etag: 'BwX1', bindings });
    await expect(google.request('POST', `${CRM}/projects/demo-project:setIamPolicy`, { policy })).rejects.toMatchObject({ status: 409 });
  });

  it('grants requested permissions unless told otherwise', async () => {
    const google = fake();
    const url = `${CRM}/projects/demo-project:testIamPermissions`;
    expect(await google.request('POST', url, { permissions: ['a', 'b'] })).toEqual({ permissions: ['a', 'b'] });
    google.state.projects[0]!.grantedPermissions = ['b'];
    expect(await google.request('POST', url, { permissions: ['a', 'b'] })).toEqual({ permissions: ['b'] });
  });

  it('reports service states', async () => {
    const google = fake();
    const names = ['iam.googleapis.com', 'sts.googleapis.com'].map((api) => `names=projects/demo-project/services/${api}`).join('&');
    expect(await google.request('GET', `${SU}/projects/demo-project/services:batchGet?${names}`)).toEqual({
      services: [
        { name: 'projects/123/services/iam.googleapis.com', state: 'ENABLED' },
        { name: 'projects/123/services/sts.googleapis.com', state: 'DISABLED' },
      ],
    });
    expect(await google.request('GET', `${SU}/projects/123/services/sts.googleapis.com`)).toEqual({
      name: 'projects/123/services/sts.googleapis.com',
      state: 'DISABLED',
    });
  });

  it('serves pools and providers by project ID or number', async () => {
    const google = fake();
    expect(await google.request('GET', `${IAM}/projects/demo-project/locations/global/workloadIdentityPools/github`)).toEqual({
      name: POOL,
      state: 'ACTIVE',
      disabled: false,
    });
    expect(await google.request('GET', `${IAM}/${POOL}/providers/gh`)).toMatchObject({ attributeCondition: 'x', state: 'ACTIVE' });
    await expect(google.request('GET', `${IAM}/${POOL}/providers/missing`)).rejects.toMatchObject({ status: 404 });
  });

  it('serves service accounts, keys, and policies', async () => {
    const google = fake();
    const base = `${IAM}/projects/-/serviceAccounts/sa@demo-project.iam.gserviceaccount.com`;
    expect(await google.request('GET', base)).toEqual({ email: 'sa@demo-project.iam.gserviceaccount.com', disabled: false, description: undefined });
    expect(await google.request('GET', `${base}/keys?keyTypes=USER_MANAGED`)).toEqual({
      keys: [{ name: 'projects/-/serviceAccounts/sa@demo-project.iam.gserviceaccount.com/keys/k1' }],
    });
    const policy = await google.request<{ etag: string }>('POST', `${base}:getIamPolicy`);
    await google.request('POST', `${base}:setIamPolicy`, { policy: { ...policy, bindings: [{ role: 'r', members: ['m'] }] } });
    expect(await google.request('POST', `${base}:getIamPolicy`)).toMatchObject({ bindings: [{ role: 'r' }] });
    await expect(google.request('GET', `${IAM}/projects/-/serviceAccounts/missing@x.iam.gserviceaccount.com`)).rejects.toMatchObject({ status: 404 });
  });

  it('answers 403 for IAM while the IAM API is off and for forbidden URLs', async () => {
    const google = fake();
    google.state.projects[0]!.enabledServices = [];
    await expect(google.request('GET', `${IAM}/${POOL}`)).rejects.toMatchObject({ status: 403 });
    await expect(google.request('GET', `${IAM}/projects/-/serviceAccounts/sa@demo-project.iam.gserviceaccount.com`)).rejects.toMatchObject({ status: 403 });

    google.state.forbidden = [':getIamPolicy'];
    await expect(google.request('POST', `${CRM}/projects/demo-project:getIamPolicy`)).rejects.toMatchObject({ status: 403 });
  });

  it('records calls and returns copies', async () => {
    const google = fake();
    const project = await google.request<{ projectId: string }>('GET', `${CRM}/projects/demo-project`);
    project.projectId = 'changed';
    await google.request('POST', `${CRM}/projects/demo-project:testIamPermissions`, { permissions: [] });
    expect(google.calls).toEqual([
      { method: 'GET', url: `${CRM}/projects/demo-project` },
      { method: 'POST', url: `${CRM}/projects/demo-project:testIamPermissions`, body: { permissions: [] } },
    ]);
    expect(google.state.projects[0]!.projectId).toBe('demo-project');
    await expect(google.request('GET', 'https://example.test/unknown')).rejects.toMatchObject({ status: 404 });
  });
});
