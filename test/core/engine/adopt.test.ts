import { describe, expect, it } from 'vitest';
import { findAdoptCandidate, LEGACY_VARIABLES } from '../../../src/core/engine/adopt.js';

const project = { projectId: 'demo-project', projectNumber: '123' };
const provider = (number = '123', id = 'github-actions') =>
  `projects/${number}/locations/global/workloadIdentityPools/github/providers/${id}`;
const account = (projectId = 'demo-project') => `github-deploy@${projectId}.iam.gserviceaccount.com`;

describe('findAdoptCandidate', () => {
  it('knows the setup-wif.sh and hoverboard variable names', () => {
    expect(LEGACY_VARIABLES).toEqual([
      ['GCP_WIF_PROVIDER', 'GCP_DEPLOY_SA'],
      ['WIF_PROVIDER', 'DEPLOY_SERVICE_ACCOUNT'],
    ]);
    for (const [providerName, accountName] of LEGACY_VARIABLES) {
      expect(
        findAdoptCandidate(
          [
            { name: providerName, value: provider() },
            { name: accountName, value: ` ${account()}\n` },
          ],
          project,
        ),
      ).toEqual({
        provider: provider(),
        serviceAccount: account(),
        variables: { provider: providerName, serviceAccount: accountName },
      });
    }
  });

  it('prefers a known pair over other matching variables', () => {
    const candidate = findAdoptCandidate(
      [
        { name: 'A', value: provider('123', 'other') },
        { name: 'B', value: account() },
        { name: 'WIF_PROVIDER', value: provider() },
        { name: 'DEPLOY_SERVICE_ACCOUNT', value: account() },
      ],
      project,
    );
    expect(candidate?.variables).toEqual({ provider: 'WIF_PROVIDER', serviceAccount: 'DEPLOY_SERVICE_ACCOUNT' });
  });

  it('falls back to any variables with matching values', () => {
    expect(
      findAdoptCandidate(
        [
          { name: 'NODE_VERSION', value: '24' },
          { name: 'MY_PROVIDER', value: provider() },
          { name: 'MY_SA', value: account() },
        ],
        project,
      )?.variables,
    ).toEqual({ provider: 'MY_PROVIDER', serviceAccount: 'MY_SA' });
  });

  it('ignores other projects and incomplete pairs', () => {
    expect(findAdoptCandidate([{ name: 'GCP_WIF_PROVIDER', value: provider() }], project)).toBeUndefined();
    expect(
      findAdoptCandidate(
        [
          { name: 'GCP_WIF_PROVIDER', value: provider('999') },
          { name: 'GCP_DEPLOY_SA', value: account() },
        ],
        project,
      ),
    ).toBeUndefined();
    expect(
      findAdoptCandidate(
        [
          { name: 'GCP_WIF_PROVIDER', value: provider() },
          { name: 'GCP_DEPLOY_SA', value: account('other-project') },
        ],
        project,
      ),
    ).toBeUndefined();
    expect(findAdoptCandidate([], project)).toBeUndefined();
  });
});
