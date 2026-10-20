// Compiled against the built .d.ts files by `npm run typecheck:consumer`; never run.
import {
  FirebaseWifError,
  HttpError,
  plan,
  resolveContext,
  setup,
  status,
  type ApplyResult,
  type Change,
  type ChangeAction,
  type Check,
  type CheckStatus,
  type Context,
  type GitHubClient,
  type GoogleClient,
  type Options,
  type PresetName,
  type ProgressEvent,
  type SetupResult,
  type StatusReport,
} from '@abraham/firebase-wif';
import {
  createCredentialsConfig,
  verifyCredentials,
  type ExternalAccountConfig,
} from '@abraham/firebase-wif/credentials';
import { ghCliClient, type GhRunner } from '@abraham/firebase-wif/gh';
import { apisFor, PRESET_NAMES, PRESETS, resolvePresets, rolesFor } from '@abraham/firebase-wif/presets';
import { createConfiguredFakes, createFakeGitHub, createFakeGoogle } from '@abraham/firebase-wif/testing';

const google: GoogleClient = {
  request: async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    throw new HttpError(500, `${method} ${url} ${JSON.stringify(body)}`);
  },
};
const github: GitHubClient = createFakeGitHub();

const log = (event: ProgressEvent): string => {
  switch (event.type) {
    case 'check':
      return `${event.check.id} ${event.check.status}`;
    case 'change:start':
    case 'change:done':
      return event.change.description;
    case 'operation:wait':
      return `${event.name} ${event.attempt}`;
    case 'retry':
      return `${event.reason} ${event.delayMs}`;
  }
};

const presets: PresetName[] = [...PRESET_NAMES, ...resolvePresets({ hosting: {} })];

const options: Options = {
  projectId: 'demo-project',
  repo: 'octo-org/site',
  google,
  github: false,
  presets: 'auto',
  firebaseJson: { hosting: {} },
  roles: ['roles/cloudscheduler.admin'],
  runtimeServiceAccounts: ['runtime@demo-project.iam.gserviceaccount.com'],
  names: { pool: 'github', provider: 'github-1', serviceAccount: 'github-1' },
  variables: { provider: 'FIREBASE_WIF_PROVIDER', serviceAccount: 'FIREBASE_WIF_SERVICE_ACCOUNT' },
  home: {
    provider: 'projects/1/locations/global/workloadIdentityPools/github/providers/github-1',
    serviceAccount: 'a',
  },
  environment: { name: 'production', branch: false },
  prune: true,
  adopt: async (candidate) => candidate.variables.provider.length > 0,
  local: { firebaseJson: {}, firebaserc: { projects: { default: 'demo-project' } }, workflows: {} },
  onEvent: (event) => void log(event),
  signal: AbortSignal.timeout(1000),
  sleep: async () => {},
};

export const run = async (): Promise<number> => {
  const resolved = await resolveContext({ cwd: '.', project: 'default' });
  const report: StatusReport = await status({ ...options, projectId: resolved.projectId, local: resolved.local });
  const failed: Check[] = report.checks.filter((check) => check.status === ('fail' satisfies CheckStatus));
  const context: Context = report.context;

  const planned = await plan({ ...options, google: { accessToken: 'token' }, github: { token: 'token' } });
  const actions: ChangeAction[] = planned.changes.map((change: Change) => change.action);
  const applied: ApplyResult = await planned.apply({ signal: AbortSignal.timeout(1000) });

  const result: SetupResult = await setup({ ...options, confirm: async (next) => next.changes.length > 0 });
  const cancelled = result.cancelled ? result.plan.changes.length : result.applied.length;

  return failed.length + context.roles.length + actions.length + applied.manual.length + cancelled;
};

export const handle = (error: unknown): string | undefined =>
  error instanceof FirebaseWifError ? `${error.code}: ${error.fix ?? error.message}` : undefined;

const config: ExternalAccountConfig = createCredentialsConfig({
  provider: 'projects/1/locations/global/workloadIdentityPools/github/providers/github-1',
  serviceAccount: 'github-1@demo-project.iam.gserviceaccount.com',
  requestUrl: 'https://example.com',
  requestToken: 'token',
});
export const verified: Promise<void> = verifyCredentials(config, { signal: AbortSignal.timeout(1000), fetch });

const runner: GhRunner = async () => ({ code: 0, stdout: '{}', stderr: '' });
export const clients: GitHubClient[] = [ghCliClient(), ghCliClient({ run: runner }), createFakeGitHub()];

const fakes = createConfiguredFakes({ presets: ['hosting'] });
export const fakeReport: Promise<StatusReport> = status({
  ...fakes.options,
  google: fakes.google,
  github: fakes.github,
});
export const fakeGoogle: GoogleClient = createFakeGoogle();

export const roles: string[] = rolesFor({ presets, roles: [...PRESETS.hosting.roles] });
export const apis: string[] = apisFor(presets);
export { github };
