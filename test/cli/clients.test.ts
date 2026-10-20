import { describe, expect, it } from 'vitest';
import { connect } from '../../src/cli/clients.js';
import { createOutput } from '../../src/cli/output.js';
import { FirebaseWifError } from '../../src/index.js';
import { createFakeGitHub, createFakeGoogle } from '../../src/testing/index.js';

const capture = () => {
  let stderr = '';
  const output = createOutput({ stdout: () => {}, stderr: (text) => (stderr += text), json: false, all: false });
  return { output, stderr: () => stderr };
};

const noCredentials = (code: 'NO_GOOGLE_CREDENTIALS' | 'NO_GITHUB_CREDENTIALS') => async () => {
  throw new FirebaseWifError(code, 'No credentials.', { fix: 'log in' });
};

describe('connect', () => {
  it('returns both clients', async () => {
    const google = createFakeGoogle();
    const github = createFakeGitHub();
    const result = await connect(
      { env: {}, googleClient: async () => google, githubClient: async () => github },
      capture().output,
    );
    expect(result).toEqual({ kind: 'connected', google, github });
  });

  it('fails with exit 3 without Google credentials', async () => {
    const { output, stderr } = capture();
    const result = await connect({ env: {}, googleClient: noCredentials('NO_GOOGLE_CREDENTIALS') }, output);
    expect(result).toEqual({ kind: 'failed', code: 3 });
    expect(stderr()).toBe('No credentials.\n  fix: log in\n');
  });

  it('continues without GitHub, with a note', async () => {
    const { output, stderr } = capture();
    const result = await connect(
      { env: {}, googleClient: async () => createFakeGoogle(), githubClient: noCredentials('NO_GITHUB_CREDENTIALS') },
      output,
    );
    expect(result).toMatchObject({ kind: 'connected', github: false });
    expect(stderr()).toBe('No GitHub credentials; skipping GitHub checks. Run gh auth login to include them.\n');
  });
});
