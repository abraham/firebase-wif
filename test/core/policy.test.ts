import { describe, expect, it } from 'vitest';
import { desiredAttributeCondition } from '../../src/core/naming.js';
import { addMember, analyzeCondition, hasMember, removeMember, rolesOf, type Policy } from '../../src/core/policy.js';

describe('addMember and removeMember', () => {
  const conditional = { role: 'roles/viewer', members: ['user:a@example.com'], condition: { expression: 'false' } };
  const policy: Policy = {
    version: 3,
    etag: 'BwX1',
    bindings: [conditional, { role: 'roles/editor', members: ['user:b@example.com'] }],
  };

  it('adds to the unconditional binding, keeping everything else', () => {
    expect(addMember(policy, 'roles/viewer', 'user:a@example.com')).toEqual({
      ...policy,
      bindings: [conditional, policy.bindings![1], { role: 'roles/viewer', members: ['user:a@example.com'] }],
    });
    expect(addMember(policy, 'roles/editor', 'user:c@example.com').bindings![1]).toEqual({
      role: 'roles/editor',
      members: ['user:b@example.com', 'user:c@example.com'],
    });
    expect(addMember({}, 'roles/editor', 'user:c@example.com')).toEqual({ bindings: [{ role: 'roles/editor', members: ['user:c@example.com'] }] });
  });

  it('returns the same policy when the member is already there', () => {
    expect(addMember(policy, 'roles/editor', 'user:b@example.com')).toBe(policy);
  });

  it('removes only from unconditional bindings and drops empty ones', () => {
    expect(removeMember(policy, 'roles/viewer', 'user:a@example.com')).toEqual(policy);
    expect(removeMember(policy, 'roles/editor', 'user:b@example.com')).toEqual({ ...policy, bindings: [conditional] });
    const shared = addMember(policy, 'roles/editor', 'user:c@example.com');
    expect(removeMember(shared, 'roles/editor', 'user:b@example.com').bindings![1]).toEqual({
      role: 'roles/editor',
      members: ['user:c@example.com'],
    });
    expect(removeMember({}, 'roles/editor', 'user:b@example.com')).toEqual({ bindings: [] });
  });
});

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
