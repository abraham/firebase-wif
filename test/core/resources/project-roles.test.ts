import { describe, expect, it } from 'vitest';
import { projectRoles } from '../../../src/core/resources/project-roles.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.project-roles', () => {
  it('grants each missing role separately', async () => {
    const fakes = createConfiguredFakes({ presets: ['hosting', 'firestore'] });
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.iamPolicy = {
      bindings: [{ role: 'roles/firebasehosting.admin', members: [`serviceAccount:${fakes.names.serviceAccount}`] }],
    };
    expect(actions(await projectRoles.evaluate(rt))).toEqual(
      ['roles/datastore.indexAdmin', 'roles/firebaserules.admin', 'roles/serviceusage.serviceUsageConsumer'].map(
        (role) => `bind: grant ${role} on demo-project to ${fakes.names.serviceAccount}`,
      ),
    );
  });

  it('removes unrequested roles only from a managed account when pruning', async () => {
    const fakes = createConfiguredFakes();
    const member = `serviceAccount:${fakes.names.serviceAccount}`;
    fakes.google.state.projects[0]!.iamPolicy.bindings!.push({ role: 'roles/editor', members: [member] });
    const rt = await runtimeFor(fakes, { prune: true });
    expect(actions(await projectRoles.evaluate(rt))).toEqual([
      `unbind: remove roles/editor on demo-project from ${fakes.names.serviceAccount}`,
    ]);

    fakes.google.state.serviceAccounts[fakes.names.serviceAccount]!.description = 'made by hand';
    expect(actions(await projectRoles.evaluate(await runtimeFor(fakes, { prune: true })))).toBe('ok');
  });
});
