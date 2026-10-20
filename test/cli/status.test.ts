import { describe, expect, it } from 'vitest';
import { createOutput } from '../../src/cli/output.js';
import { runStatus } from '../../src/cli/status.js';
import { createConfiguredFakes } from '../../src/testing/index.js';

const SOURCES = { projectId: '--project', repo: '--repo' };

const capture = (json: boolean) => {
  let stdout = '';
  const output = createOutput({ stdout: (text) => (stdout += text), stderr: () => {}, json, all: false });
  return { output, stdout: () => stdout };
};

describe('runStatus', () => {
  it('prints the report and returns its context', async () => {
    const fakes = createConfiguredFakes();
    const { output, stdout } = capture(false);
    const outcome = await runStatus(
      { ...fakes.options, google: fakes.google, github: fakes.github },
      { output, sources: SOURCES },
    );
    expect(outcome.code).toBe(0);
    expect(outcome.context?.projectId).toBe('demo-project');
    expect(stdout()).toContain('from --project');
  });

  it('exits 1 when a check fails, and prints JSON with --json', async () => {
    const fakes = createConfiguredFakes();
    fakes.github.state.repos['octo-org/site']!.variables = {};
    const { output, stdout } = capture(true);
    const outcome = await runStatus(
      { ...fakes.options, google: fakes.google, github: fakes.github },
      { output, sources: SOURCES },
    );
    expect(outcome.code).toBe(1);
    expect(JSON.parse(stdout()).ok).toBe(false);
  });

  it('reports errors without a context', async () => {
    const fakes = createConfiguredFakes();
    const { output } = capture(false);
    const outcome = await runStatus(
      { ...fakes.options, projectId: 'missing-project', google: fakes.google, github: fakes.github },
      { output, sources: SOURCES },
    );
    expect(outcome).toEqual({ code: 3 });
  });
});
