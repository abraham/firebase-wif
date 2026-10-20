import { describe, expect, it } from 'vitest';
import { GCP_ADVISORIES } from '../../../src/core/checks/gcp.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { runtimeFor } from '../../helpers.js';

const { project, operator, serviceAccountKeys, extraRoles, broadImpersonation } = GCP_ADVISORIES;

describe('Google Cloud checks', () => {
  it('gcp.project and gcp.operator', async () => {
    const rt = await runtimeFor();
    expect(await project.run(rt)).toEqual({
      status: 'pass',
      message: 'demo-project accessible (#123456789012)',
    });
    expect((await operator.run(rt)).status).toBe('pass');
    expect(
      await operator.run({
        ...rt,
        preflight: { missingPermissions: ['iam.serviceAccounts.create'], githubAdmin: true },
      }),
    ).toMatchObject({ status: 'warn', message: expect.stringContaining('iam.serviceAccounts.create') });
  });

  it('gcp.sa-keys', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    expect((await serviceAccountKeys.run(rt)).status).toBe('pass');

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.keys = ['a', 'b'];
    expect(await serviceAccountKeys.run(await runtimeFor(fakes))).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('2 user-managed keys'),
    });

    delete fakes.google.state.serviceAccounts[fakes.names.serviceAccount];
    expect(await serviceAccountKeys.run(await runtimeFor(fakes))).toEqual({
      status: 'skipped',
      message: "service account doesn't exist yet",
    });
  });

  it('gcp.extra-roles suggests --prune only for managed accounts', async () => {
    const fakes = createConfiguredFakes();
    fakes.google.state.projects[0]!.iamPolicy.bindings!.push({
      role: 'roles/editor',
      members: [`serviceAccount:${fakes.names.serviceAccount}`],
    });
    expect(await extraRoles.run(await runtimeFor(fakes))).toMatchObject({
      status: 'warn',
      fix: 'firebase-wif setup --prune',
    });

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.description = 'made by hand';
    expect(await extraRoles.run(await runtimeFor(fakes))).toMatchObject({
      fix: 'Remove the extra roles if deploys no longer need them.',
    });
  });

  it('gcp.wi-user-broad', async () => {
    const fakes = createConfiguredFakes();
    expect((await broadImpersonation.run(await runtimeFor(fakes))).status).toBe('pass');

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.iamPolicy!.bindings!.push(
      { role: 'roles/iam.serviceAccountTokenCreator', members: ['principal://iam.googleapis.com/x/subject/y'] },
      { role: 'roles/viewer', members: ['principalSet://iam.googleapis.com/ignored'] },
    );
    expect(await broadImpersonation.run(await runtimeFor(fakes))).toMatchObject({
      status: 'warn',
      message: expect.not.stringContaining('ignored'),
    });
  });
});
