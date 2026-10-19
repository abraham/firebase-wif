import { describe, expect, it } from 'vitest';
import { desiredAttributeCondition } from '../../src/core/naming.js';
import { analyzeCondition, hasMember, rolesOf } from '../../src/core/policy.js';

describe('hasMember and rolesOf', () => {
  const policy = {
    bindings: [
      { role: 'roles/a', members: ['serviceAccount:x'] },
      { role: 'roles/a', members: ['serviceAccount:y'] },
      { role: 'roles/b', members: ['serviceAccount:x'], condition: { expression: 'true' } },
      { role: 'roles/c' },
    ],
  };

  it('ignores conditional bindings', () => {
    expect(hasMember(policy, 'roles/a', 'serviceAccount:x')).toBe(true);
    expect(hasMember(policy, 'roles/b', 'serviceAccount:x')).toBe(false);
    expect(hasMember(policy, 'roles/c', 'serviceAccount:x')).toBe(false);
    expect(rolesOf(policy, 'serviceAccount:x')).toEqual(['roles/a']);
  });

  it('handles empty policies', () => {
    expect(hasMember({}, 'roles/a', 'serviceAccount:x')).toBe(false);
    expect(rolesOf({}, 'serviceAccount:x')).toEqual([]);
  });
});

describe('analyzeCondition', () => {
  it.each([
    [undefined, { kind: 'missing' }],
    ['  ', { kind: 'missing' }],
    ["assertion.repository_id == '42'", { kind: 'pinned' }],
    ['assertion.repository_id=="42"', { kind: 'pinned' }],
    [desiredAttributeCondition(42, 7), { kind: 'pinned' }],
    ["assertion.repository_id == '43'", { kind: 'other-repo', other: 'id 43' }],
    ["assertion.repository == 'O/R'", { kind: 'name-only' }],
    ["assertion.repository == 'x/y'", { kind: 'other-repo', other: 'x/y' }],
    ["assertion.repository_id == '42' || true", { kind: 'loose' }],
    ["assertion.repository_owner == 'o'", { kind: 'loose' }],
  ])('%s', (condition, expected) => {
    expect(analyzeCondition(condition, 42, 'o/r')).toEqual(expected);
  });
});
