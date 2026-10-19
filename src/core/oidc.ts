/** Google rejects a mapped `google.subject` longer than this. */
export const GOOGLE_SUBJECT_MAX_BYTES = 127;

// Claims whose values aren't knowable ahead of time are estimated with a placeholder this long.
const UNKNOWN_CLAIM_BYTES = 40;

export interface SubTemplate {
  useDefault: boolean;
  includeClaimKeys: string[];
}

export interface SubEstimate {
  /** The longest `sub` among the contexts that deploy. */
  longest: string;
  bytes: number;
}

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

/** Estimates the `sub` claim GitHub mints for branch, environment, and pull request jobs. */
export const estimateSub = (
  template: SubTemplate,
  {
    repo,
    repoId,
    ownerId,
    branch,
    environment,
  }: {
    repo: string;
    repoId: number;
    ownerId: number;
    branch: string;
    environment?: string;
  },
): SubEstimate => {
  const contexts = [`ref:refs/heads/${branch}`, 'pull_request', ...(environment ? [`environment:${environment}`] : [])];

  const render = (context: string): string => {
    if (template.useDefault || !template.includeClaimKeys.length) return `repo:${repo}:${context}`;
    return template.includeClaimKeys
      .map((key) => {
        switch (key) {
          case 'repo':
            return `repo:${repo}`;
          case 'context':
            return context;
          case 'repository_owner':
            return `repository_owner:${repo.split('/')[0]}`;
          case 'repository_owner_id':
            return `repository_owner_id:${ownerId}`;
          case 'repository_id':
            return `repository_id:${repoId}`;
          case 'ref':
            return `ref:refs/heads/${branch}`;
          case 'environment':
            return `environment:${environment ?? ''}`;
          case 'job_workflow_ref':
            return `job_workflow_ref:${repo}/.github/workflows/deploy.yml@refs/heads/${branch}`;
          default:
            return `${key}:${'x'.repeat(UNKNOWN_CLAIM_BYTES)}`;
        }
      })
      .join(':');
  };

  const longest = contexts.map(render).reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
  return { longest, bytes: bytes(longest) };
};
