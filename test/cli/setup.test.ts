import { describe, expect, it } from 'vitest';
import { createOutput } from '../../src/cli/output.js';
import { runSetup, type SetupContext } from '../../src/cli/setup.js';
import { createConfiguredFakes, type ConfiguredFakes } from '../../src/testing/index.js';

const broken = () => {
  const fakes = createConfiguredFakes();
  delete fakes.google.state.pools[fakes.names.pool];
  return fakes;
};

const setupWith = async (
  fakes: ConfiguredFakes,
  {
    json = false,
    interactive = false,
    answer = true,
    ...args
  }: Partial<SetupContext['args']> & { json?: boolean; interactive?: boolean; answer?: boolean } = {},
) => {
  let stdout = '';
  let stderr = '';
  const questions: string[] = [];
  const output = createOutput({
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    json,
    all: false,
  });
  const outcome = await runSetup(
    { ...fakes.options, google: fakes.google, github: fakes.github, sleep: async () => {} },
    {
      args: { dryRun: false, yes: false, adopt: false, prune: false, detailed: false, ...args },
      output,
      sources: { projectId: '--project', repo: '--repo' },
      ask: async (question) => (questions.push(question), answer),
      interactive,
    },
  );
  return { outcome, stdout, stderr, questions };
};

const writes = (fakes: ConfiguredFakes) => fakes.google.calls.filter((c) => c.method !== 'GET' && !c.url.includes(':'));

describe('runSetup', () => {
  it('prints the plan for --dry-run without writing', async () => {
    const fakes = broken();
    const { outcome, stdout } = await setupWith(fakes, { dryRun: true });
    expect(outcome.code).toBe(0);
    expect(stdout).toContain('+ create the GitHub identity pool');
    expect(writes(fakes)).toEqual([]);
  });

  it('prints resource names with --detailed', async () => {
    const { stdout } = await setupWith(broken(), { dryRun: true, detailed: true });
    expect(stdout).toContain('+ create workload identity pool github');
  });

  it('exits 0 with the context when already set up', async () => {
    const { outcome, stdout } = await setupWith(createConfiguredFakes());
    expect(outcome).toMatchObject({ code: 0, context: { projectId: 'demo-project' } });
    expect(stdout).toContain('Already set up.');
  });

  it('needs --yes when it cannot ask', async () => {
    const fakes = broken();
    const { outcome, stderr } = await setupWith(fakes);
    expect(outcome).toEqual({ code: 2 });
    expect(stderr).toBe('Pass --yes to apply changes without a prompt.\n');
    expect(writes(fakes)).toEqual([]);
  });

  it('asks, and exits 1 when declined', async () => {
    const fakes = broken();
    const { outcome, stdout, questions } = await setupWith(fakes, { interactive: true, answer: false });
    expect(outcome).toEqual({ code: 1 });
    expect(questions).toEqual(['Apply these changes?']);
    expect(stdout).toContain('Cancelled; nothing changed.');
    expect(writes(fakes)).toEqual([]);
  });

  it('applies with --yes, printing progress and the final status', async () => {
    const { outcome, stdout } = await setupWith(broken(), { yes: true });
    expect(outcome.code).toBe(0);
    expect(stdout).toContain('  ✓ create the GitHub identity pool\n');
    expect(stdout).toContain('IAM changes can take a few minutes');
  });

  it('prints detailed progress with --detailed', async () => {
    const { stdout } = await setupWith(broken(), { yes: true, detailed: true });
    expect(stdout).toContain('  ✓ create workload identity pool github\n');
  });

  it('prints the apply result as JSON without the cancelled field', async () => {
    const { stdout } = await setupWith(broken(), { yes: true, json: true });
    expect(Object.keys(JSON.parse(stdout))).toEqual(['applied', 'manual', 'status']);
  });
});
