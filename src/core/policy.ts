export interface Binding {
  role: string;
  members?: string[];
  condition?: unknown;
}

export interface Policy {
  version?: number;
  etag?: string;
  bindings?: Binding[];
}

/** Only unconditional bindings count; conditional ones may not apply when a deploy runs. */
export const hasMember = (policy: Policy, role: string, member: string): boolean =>
  (policy.bindings ?? []).some(
    (binding) => binding.role === role && !binding.condition && binding.members?.includes(member),
  );

export const rolesOf = (policy: Policy, member: string): string[] =>
  [
    ...new Set(
      (policy.bindings ?? [])
        .filter((binding) => !binding.condition && binding.members?.includes(member))
        .map((binding) => binding.role),
    ),
  ].sort();

/** Adds `member` to the unconditional `role` binding; keeps `version`, `etag`, and every other binding. */
export const addMember = (policy: Policy, role: string, member: string): Policy => {
  if (hasMember(policy, role, member)) return policy;
  const bindings = [...(policy.bindings ?? [])];
  const index = bindings.findIndex((binding) => binding.role === role && !binding.condition);
  if (index < 0) bindings.push({ role, members: [member] });
  else bindings[index] = { ...bindings[index]!, members: [...(bindings[index]!.members ?? []), member] };
  return { ...policy, bindings };
};

/** Removes `member` from unconditional `role` bindings only, dropping bindings left empty. */
export const removeMember = (policy: Policy, role: string, member: string): Policy => ({
  ...policy,
  bindings: (policy.bindings ?? []).flatMap((binding) => {
    if (binding.role !== role || binding.condition || !binding.members?.includes(member)) return [binding];
    const members = binding.members.filter((m) => m !== member);
    return members.length ? [{ ...binding, members }] : [];
  }),
});

export type ConditionAnalysis =
  | { kind: 'missing' }
  | { kind: 'pinned' }
  | { kind: 'other-repo'; other: string }
  | { kind: 'name-only' }
  | { kind: 'loose' };

/** Classifies a provider's `attributeCondition` relative to one repository. */
export const analyzeCondition = (condition: string | undefined, repoId: number, repo: string): ConditionAnalysis => {
  const text = condition?.trim();
  if (!text) return { kind: 'missing' };
  if (text.includes('||')) return { kind: 'loose' };

  const byId = /assertion\.repository_id\s*==\s*['"](\d+)['"]/.exec(text);
  if (byId) return byId[1] === String(repoId) ? { kind: 'pinned' } : { kind: 'other-repo', other: `id ${byId[1]}` };

  const byName = /assertion\.repository\s*==\s*['"]([^'"]+)['"]/.exec(text);
  if (byName) {
    return byName[1]!.toLowerCase() === repo.toLowerCase()
      ? { kind: 'name-only' }
      : { kind: 'other-repo', other: byName[1]! };
  }
  return { kind: 'loose' };
};
