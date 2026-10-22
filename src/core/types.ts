/** Matches hoverboard's GoogleCloud.request, so an existing client can be passed as is. */
export interface GoogleClient {
  /** Rejects with an error that has a numeric `status` for HTTP failures. */
  request<T>(method: string, url: string, body?: unknown): Promise<T>;
}

export interface GitHubClient {
  /** `path` is relative to https://api.github.com, like `/repos/o/r`. Rejects with a numeric `status`. */
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export type GoogleAuth = GoogleClient | { accessToken: string } | { getAccessToken: () => Promise<string> };

export type GitHubAuth = GitHubClient | { token: string };

export type PresetName = 'hosting' | 'firestore' | 'storage' | 'functions';

/** Files read by `resolveContext`; the engine never touches the filesystem itself. */
export interface LocalFiles {
  firebaseJson?: Record<string, unknown> | undefined;
  firebaserc?: { projects?: Record<string, string> | undefined } | undefined;
  gitignore?: string | undefined;
  /** Workflow file contents keyed by path, like `.github/workflows/deploy.yml`. */
  workflows?: Record<string, string> | undefined;
}

export interface AdoptCandidate {
  provider: string;
  serviceAccount: string;
  variables: { provider: string; serviceAccount: string };
}

export interface Options {
  projectId: string;
  /** `owner/name` */
  repo: string;
  google?: GoogleAuth | undefined;
  /** `false` skips GitHub resources; the repo is still looked up without credentials. */
  github?: GitHubAuth | false | undefined;
  presets?: readonly PresetName[] | 'auto' | undefined;
  firebaseJson?: Record<string, unknown> | undefined;
  roles?: readonly string[] | undefined;
  runtimeServiceAccounts?: readonly string[] | undefined;
  names?: { pool?: string | undefined; provider?: string | undefined; serviceAccount?: string | undefined } | undefined;
  variables?: { provider: string; serviceAccount: string } | false | undefined;
  /**
   * An existing provider resource name and SA email to use instead of the ones the repo variables
   * point at. When they're in another project, only that project's APIs and roles are reconciled.
   */
  home?: { provider: string; serviceAccount: string } | undefined;
  /** `branch` defaults to the repo's default branch; `false` lets any branch deploy. */
  environment?: { name: string; branch?: string | false | undefined } | false | undefined;
  /**
   * An environment any branch can deploy to, for preview channels. By default it's set up only when a
   * local workflow deploys to a preview channel, named after that job's environment or `preview`.
   */
  previewEnvironment?: { name: string } | false | undefined;
  prune?: boolean | undefined;
  /** Reuse a setup found through legacy repo variables (default `false`). A function decides per candidate. */
  adopt?: boolean | ((candidate: AdoptCandidate) => boolean | Promise<boolean>) | undefined;
  local?: LocalFiles | undefined;
  onEvent?: ((event: ProgressEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface Context {
  projectId: string;
  projectNumber: string;
  repo: string;
  repoId: number;
  ownerId: number;
  defaultBranch: string;
  /** Full resource names. */
  pool: string;
  provider: string;
  /** Email. */
  serviceAccount: string;
  homeProjectId: string;
  variables: { provider: string; serviceAccount: string } | false;
  environment: { name: string; branch: string | false } | false;
  previewEnvironment: { name: string } | false;
  presets: PresetName[];
  roles: string[];
  apis: string[];
  runtimeServiceAccounts: string[];
  /** Set when the pool, provider, and service account come from legacy repo variables. */
  adopted?: AdoptCandidate;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

/** The reconcile resources, in apply order. */
export type ResourceId =
  | 'gcp.apis'
  | 'gcp.pool'
  | 'gcp.provider'
  | 'gcp.provider-condition'
  | 'gcp.service-account'
  | 'gcp.project-roles'
  | 'gcp.wi-user'
  | 'gcp.runtime-sa-user'
  | 'gh.variables'
  | 'gh.environment';

export type CheckId =
  | ResourceId
  | 'local.firebase-json'
  | 'local.project-match'
  | 'local.creds-ignored'
  | 'gcp.project'
  | 'gcp.operator'
  | 'gcp.sa-keys'
  | 'gcp.extra-roles'
  | 'gcp.wi-user-broad'
  | 'gh.repo'
  | 'gh.legacy-secrets'
  | 'gh.oidc-sub'
  | 'gh.workflows';

export interface Check {
  id: CheckId;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export type ChangeAction = 'create' | 'update' | 'undelete' | 'enable' | 'bind' | 'unbind' | 'set';

export interface Change {
  resource: ResourceId;
  action: ChangeAction;
  description: string;
  /** Plain-language `description` without resource names, emails, or role IDs. */
  summary: string;
  /** Can't be applied with the given credentials; `description` says what to do by hand. */
  manual?: boolean;
}

export interface Preflight {
  missingPermissions: string[];
  /** `undefined` when GitHub is skipped. */
  githubAdmin: boolean | undefined;
}

export interface StatusReport {
  /** No `fail` checks. */
  ok: boolean;
  context: Context;
  checks: Check[];
  changes: Change[];
  preflight: Preflight;
}

export interface Plan {
  context: Context;
  changes: Change[];
  preflight: Preflight;
  apply(options?: { signal?: AbortSignal }): Promise<ApplyResult>;
}

export interface ApplyResult {
  applied: Change[];
  manual: Change[];
  status: StatusReport;
}

export interface SetupOptions extends Options {
  /** Called with the plan before anything is written; return `false` to cancel. Default: always apply. */
  confirm?: ((plan: Plan) => boolean | Promise<boolean>) | undefined;
}

export type SetupResult = (ApplyResult & { cancelled: false }) | { cancelled: true; plan: Plan };

export type ProgressEvent =
  | { type: 'check'; check: Check }
  | { type: 'change:start' | 'change:done'; change: Change }
  | { type: 'operation:wait'; name: string; attempt: number }
  | { type: 'retry'; reason: string; attempt: number; delayMs: number };
