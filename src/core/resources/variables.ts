import type { Runtime } from '../io/reads.js';
import type { Change } from '../types.js';
import { ADMIN_FIX, change, drift, type Resource } from './resource.js';

const expectedVariables = (rt: Runtime): [name: string, value: string][] =>
  rt.ctx.variables
    ? [
        [rt.ctx.variables.provider, rt.ctx.provider],
        [rt.ctx.variables.serviceAccount, rt.ctx.serviceAccount],
      ]
    : [];

export const variables: Resource = {
  id: 'gh.variables',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const names = rt.ctx.variables;
    if (!names) return { kind: 'skipped', message: 'repo variables disabled' };
    const expected = expectedVariables(rt);
    if (!rt.github) {
      return {
        kind: 'skipped',
        message: 'no GitHub credentials',
        changes: expected.map(([name, value]) => change(this.id, 'set', `set repo variable ${name} to ${value}`, true)),
      };
    }
    const manual = rt.preflight.githubAdmin === false;
    const changes: Change[] = [];
    for (const [name, value] of expected) {
      const current = rt.variableValues.get(name) ?? { kind: 'skipped', reason: 'not read' };
      if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
      if (current.kind === 'missing' || current.value !== value) {
        changes.push(change(this.id, 'set', `set repo variable ${name} to ${value}`, manual));
      }
    }
    if (!changes.length) return { kind: 'ok', message: `${names.provider} and ${names.serviceAccount} match` };
    return drift(changes, manual ? ADMIN_FIX : undefined);
  },
  async apply(rt) {
    const github = rt.github;
    if (!github) return;
    for (const [name, value] of expectedVariables(rt)) {
      const current = rt.variableValues.get(name);
      if (current?.kind === 'missing') {
        await github.request('POST', `/repos/${rt.ctx.repo}/actions/variables`, { name, value });
      } else if (current?.kind === 'found' && current.value !== value) {
        await github.request('PATCH', `/repos/${rt.ctx.repo}/actions/variables/${name}`, { name, value });
      }
    }
  },
};
