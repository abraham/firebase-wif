import { createMemo, type Read, type RepoResource, type Runtime } from '../src/core/runtime.js';
import { status } from '../src/index.js';
import { createConfiguredFakes, type ConfiguredFakes } from '../src/testing/index.js';

/** A runtime for a fully set up repo and project; mutate the fakes afterwards to break things. */
export const runtimeFor = async (
  fakes: ConfiguredFakes = createConfiguredFakes(),
  overrides: Partial<Runtime> = {},
): Promise<Runtime> => {
  const report = await status({ ...fakes.options, google: fakes.google, github: fakes.github });
  const repo = await fakes.github.request<RepoResource>('GET', `/repos/${fakes.options.repo}`);
  const stored = fakes.github.state.repos[fakes.options.repo]!.variables ?? {};
  const names = report.context.variables ? [report.context.variables.provider, report.context.variables.serviceAccount] : [];
  const variableValues = new Map<string, Read<string>>(
    names.map((name) => [name, name in stored ? { kind: 'found', value: stored[name]! } : { kind: 'missing' }]),
  );
  fakes.google.calls.length = 0;
  fakes.github.calls.length = 0;
  return {
    ctx: report.context,
    google: fakes.google,
    github: fakes.github,
    repo,
    preflight: report.preflight,
    variableValues,
    memo: createMemo(),
    ...overrides,
  };
};
