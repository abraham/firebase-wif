import { describe, expect, it } from 'vitest';
import { apis } from '../../../src/core/resources/apis.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';
import { actions, runtimeFor } from '../../helpers.js';

describe('gcp.apis', () => {
  it('enables the disabled APIs in one change', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.projects[0]!.enabledServices = ['iam.googleapis.com', 'sts.googleapis.com'];
    expect(actions(await apis.evaluate(rt))).toEqual([
      'enable: enable cloudresourcemanager.googleapis.com, firebasehosting.googleapis.com, iamcredentials.googleapis.com',
    ]);
  });

  it('skips when the services cannot be read', async () => {
    const fakes = createConfiguredFakes();
    const rt = await runtimeFor(fakes);
    fakes.google.state.forbidden = ['serviceusage'];
    expect(await apis.evaluate(rt)).toMatchObject({
      kind: 'skipped',
      message: expect.stringContaining('insufficient permission'),
    });
  });
});
