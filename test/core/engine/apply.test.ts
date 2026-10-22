import { describe, expect, it } from 'vitest';
import { applyChanges, applyError } from '../../../src/core/engine/apply.js';
import { inspect } from '../../../src/core/engine/inspect.js';
import { FirebaseWifError, HttpError, WriteError } from '../../../src/core/errors.js';
import type { Change } from '../../../src/core/types.js';
import { createConfiguredFakes } from '../../../src/testing/index.js';

const failed: Change = {
  resource: 'gcp.pool',
  action: 'create',
  description: 'create workload identity pool github',
  summary: 'create the GitHub identity pool',
};
const done: Change = {
  resource: 'gcp.apis',
  action: 'enable',
  description: 'enable iam.googleapis.com',
  summary: 'turn on 1 Google Cloud API',
};

describe('applyError', () => {
  it('wraps other errors as APPLY_FAILED with what was applied', () => {
    expect(applyError(new HttpError(500, 'boom'), failed, [done])).toMatchObject({
      code: 'APPLY_FAILED',
      message: "Couldn't create workload identity pool github (500): boom. Already applied: enable iam.googleapis.com.",
      details: { failed, applied: [done] },
    });
  });

  it('keeps the code of write errors and foreign providers', () => {
    const timeout = new WriteError('OPERATION_TIMEOUT', 'Timed out.', 'Re-run.');
    expect(applyError(timeout, failed, [])).toMatchObject({
      code: 'OPERATION_TIMEOUT',
      fix: 'Re-run.',
      details: { failed, applied: [] },
    });
    const owned = new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', 'Not ours.');
    expect(applyError(owned, failed, [])).toMatchObject({ code: 'PROVIDER_OWNED_BY_OTHER_REPO' });
  });

  it('passes aborts and other library errors through', () => {
    const abort = new DOMException('stop', 'AbortError');
    expect(applyError(abort, failed, [])).toBe(abort);
    const invalid = new FirebaseWifError('INVALID_NAME', 'Bad.');
    expect(applyError(invalid, failed, [])).toBe(invalid);
  });
});

describe('applyChanges', () => {
  it('applies the changes and returns the status after them', async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.pools[fakes.names.pool];
    const options = { ...fakes.options, google: fakes.google, github: fakes.github, sleep: async () => {} };
    const result = await applyChanges(options, await inspect(options), undefined);
    expect(result.applied.map((c) => c.description)).toContain('create workload identity pool github');
    expect(result.status.ok).toBe(true);
  });

  it("doesn't recreate a provider that still reads as missing right after creating it", async () => {
    const fakes = createConfiguredFakes();
    delete fakes.google.state.providers[fakes.names.provider];
    // inspect, the first pass, then the second pass right after the create.
    fakes.google.state.failures.push({ url: fakes.names.provider, method: 'GET', status: 404, times: 3 });
    const options = { ...fakes.options, google: fakes.google, github: fakes.github, sleep: async () => {} };
    const result = await applyChanges(options, await inspect(options), undefined);
    const creates = fakes.google.calls.filter((c) => c.method === 'POST' && c.url.includes('/providers?'));
    expect(creates).toHaveLength(1);
    expect(result.status.ok).toBe(true);
  });
});
