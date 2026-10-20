# Node API

Code: `src/index.ts`, `src/core/types.ts`, `src/core/errors.ts`, `src/presets.ts`, `src/credentials.ts`, `src/gh.ts`, `src/testing/`
Tests: `test/index.test.ts`, `test/core/types.test.ts`, `test/presets.test.ts`, `test/credentials.test.ts`, `test/gh.test.ts`, `test/testing/`, `test/structure.test.ts`, `test/consumer/`

`@abraham/firebase-wif` is a library first. The CLI and the Action are thin layers over it, and anything the CLI can do, a program can do through the API. Tools that already have their own CLI, prompts, and project config pass those in and get the reconcile engine, checks, presets, and credential helpers without any of the CLI's I/O.

How `status`, `plan`, and `setup` decide what to check and change is in `reconcile.md`. This spec covers the API surface: entry points, functions, options, results, errors, and the contract every function keeps.

## Entry points

The package is ESM only and ships its own type declarations. These are the only public entry points; everything else, including the CLI and the Action, is private.

| Import                              | Values                                                                                                                                                                                                                                                                                            | Types                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@abraham/firebase-wif`             | `status`, `plan`, `setup`, `resolveContext`, `projectAliases`, `parseGitHubRemote`, `createGoogleClient`, `createGitHubClient`, `defaultGoogleClient`, `defaultGitHubClient`, `SETUP_PERMISSIONS`, `CROSS_PROJECT_PERMISSIONS`, `DEFAULTS`, `FirebaseWifError`, `isFirebaseWifError`, `HttpError` | `Options`, `SetupOptions`, `GoogleClient`, `GitHubClient`, `GoogleAuth`, `GitHubAuth`, `Exec`, `ResolvedContext`, `ProjectAlias`, `LocalFiles`, `StatusReport`, `Plan`, `ApplyResult`, `SetupResult`, `Check`, `CheckId`, `CheckStatus`, `Change`, `ChangeAction`, `ResourceId`, `Preflight`, `Context`, `AdoptCandidate`, `PresetName`, `ProgressEvent`, `ErrorCode`, `ErrorDetails` |
| `@abraham/firebase-wif/presets`     | `PRESET_NAMES`, `PRESETS`, `BASE_APIS`, `SERVICE_ACCOUNT_USER_ROLE`, `resolvePresets`, `isPresetName`, `rolesFor`, `apisFor`                                                                                                                                                                      | `Preset`, `PresetName`                                                                                                                                                                                                                                                                                                                                                                |
| `@abraham/firebase-wif/credentials` | `createCredentialsConfig`, `verifyCredentials`, `parseProviderName`, `FirebaseWifError`, `isFirebaseWifError`                                                                                                                                                                                     | `ExternalAccountConfig`, `CredentialsInput`                                                                                                                                                                                                                                                                                                                                           |
| `@abraham/firebase-wif/gh`          | `ghCliClient`                                                                                                                                                                                                                                                                                     | `GhRunner`, `GhResult`, `GitHubClient`                                                                                                                                                                                                                                                                                                                                                |
| `@abraham/firebase-wif/testing`     | `createFakeGoogle`, `createFakeGitHub`, `createConfiguredFakes`                                                                                                                                                                                                                                   | `FakeGoogle`, `FakeGoogleState`, `FakeGitHub`, `FakeGitHubState`, their seed record types, `ConfiguredFakes`, `ConfiguredFakesOptions`                                                                                                                                                                                                                                                |

`FirebaseWifError` and `isFirebaseWifError` are the same in every entry point that exports them, so `instanceof` works whichever one a caller imports. Every entry point that can throw a `FirebaseWifError` exports it, so catching `VERIFY_FAILED` doesn't need the engine.

The library entry points don't import the CLI's dependencies (argument parsing, prompts) or anything from the Action. The other way round, the CLI imports only from these entry points, never from internal modules, so it can't do anything a program can't. It confirms through `setup`'s `confirm` rather than a separate permission check, and gets its defaults from `DEFAULTS`. Likewise, the Action is built only on `/credentials` (see `action.md`).

## Library contract

Every exported function keeps these rules:

- **No side effects on import.** Importing any entry point does nothing: no I/O, no timers, no global state.
- **No I/O of its own.** `status`, `plan`, `apply`, and `setup` never write to stdout or stderr, never prompt, never call `process.exit`, and never read `process.env`, `process.cwd()`, or the filesystem. The only functions that discover things are `resolveContext` and the default clients, and only when called. The default clients are used when `google` or `github` isn't passed, so pass clients to keep a call free of environment lookups.
- **Explicit inputs.** `projectId` and `repo` are required. Discovery from `.firebaserc` and the git remote is opt-in through `resolveContext`.
- **Expected states are data.** A missing pool, a failed check, or a change that needs a human are returned in the result, not thrown. Only problems that stop the run throw a `FirebaseWifError` (see Errors).
- **Cancellable.** Every call takes an `AbortSignal`. When it fires, the call rejects with an `AbortError` at the next request, poll, or retry, and makes no further requests.
- **Never surfaces secrets.** Results, events, and errors never contain access tokens, the OIDC request token, or credentials JSON. Errors from injected clients are wrapped into a `FirebaseWifError` using only their status and message, never passed through, because they may carry request headers.

## Functions

| Function                                                               | Description                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status(options: Options): Promise<StatusReport>`                      | Read-only. Runs every reconcile resource's read and diff, plus the advisory checks. `ok` is false when any check fails.                                                                                                                                                                                                                          |
| `plan(options: Options): Promise<Plan>`                                | Read-only. Returns the ordered changes `setup` would make and an `apply()` bound to them. Throws when a resource can't be set up safely, such as a provider that trusts another repository.                                                                                                                                                      |
| `Plan.apply(options?: { signal?: AbortSignal }): Promise<ApplyResult>` | Re-reads each resource right before writing it, applies the changes, and re-runs `status`. Throws `MISSING_PERMISSIONS` before writing anything when the operator lacks permissions for Google Cloud changes.                                                                                                                                    |
| `setup(options: SetupOptions): Promise<SetupResult>`                   | `plan`, then `confirm(plan)` (default: always yes), then `apply`. Returns `{ cancelled: true, plan }` when `confirm` returns false, after checking permissions so a confirm prompt is never shown for a run that can't succeed.                                                                                                                  |
| `resolveContext(options?): Promise<ResolvedContext>`                   | Discovers the project, repo, and local files for a directory (see `context-and-credentials.md`). Takes `{ cwd, project, repo, env, exec }`, each defaulting to the process's own. Returns `{ projectId, repo, local, sources, firebaseDir, gitRoot }`, which spreads straight into `Options`: `status({ ...(await resolveContext()), google })`. |
| `projectAliases(options?): Promise<ProjectAlias[]>`                    | Each project in `.firebaserc` once, as `{ alias, projectId }` under its first alias, with `default` first. Takes `{ cwd }`. This is what `--all-aliases` runs over (see `multi-project.md`).                                                                                                                                                     |
| `parseGitHubRemote(url: string): string \| undefined`                  | Parses an https, ssh, or scp-style github.com remote into `owner/name`. Throws `REPO_NOT_FOUND` for other hosts.                                                                                                                                                                                                                                 |
| `createGoogleClient({ getAccessToken, fetch? })`                       | A `fetch` client for callers that manage Google tokens themselves.                                                                                                                                                                                                                                                                               |
| `createGitHubClient({ token?, fetch? })`                               | A `fetch` client for the GitHub REST API; without a token it makes unauthenticated requests.                                                                                                                                                                                                                                                     |
| `defaultGoogleClient({ env?, exec?, fetch? })`                         | The Google credential lookup order. Throws `NO_GOOGLE_CREDENTIALS` with the login command as the fix.                                                                                                                                                                                                                                            |
| `defaultGitHubClient({ env?, exec?, fetch? })`                         | The GitHub credential lookup order. Throws `NO_GITHUB_CREDENTIALS` with `gh auth login` as the fix.                                                                                                                                                                                                                                              |
| `isFirebaseWifError(error, code?)`                                     | Type guard for a `FirebaseWifError`, optionally with a given code, that narrows `details` to that code's shape.                                                                                                                                                                                                                                  |
| `SETUP_PERMISSIONS`, `CROSS_PROJECT_PERMISSIONS`                       | The Google Cloud permissions the preflight checks in a home project and in a project that reuses another project's trust chain (see `multi-project.md`).                                                                                                                                                                                         |
| `DEFAULTS`                                                             | The default names that don't depend on the repository: `{ pool: 'github', environment: 'production', variablePrefix: 'FIREBASE_WIF_' }`.                                                                                                                                                                                                         |

`exec` (type `Exec`) runs a command without a shell and resolves with its stdout. It's how `resolveContext` reads the git remote and the default clients call `gcloud` and `gh`, and tests replace it.

## Clients

Google Cloud and GitHub access goes through two small interfaces, so callers can bring a client they already have:

```ts
interface GoogleClient {
  request<T>(method: string, url: string, body?: unknown): Promise<T>; // full URL
}

interface GitHubClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>; // path like '/repos/o/r'
}
```

Both reject HTTP failures with an error that has a numeric `status`; the built-in clients and the fakes reject with `HttpError`. `Options.google` and `Options.github` also accept shorthands:

```ts
type GoogleAuth = GoogleClient | { accessToken: string } | { getAccessToken: () => Promise<string> };
type GitHubAuth = GitHubClient | { token: string };
```

When `google` is omitted, `defaultGoogleClient()` is used; when `github` is omitted, `defaultGitHubClient()` is used. `github: false` skips GitHub entirely: the repo is still looked up without credentials, and every GitHub change becomes a manual step.

`@abraham/firebase-wif/gh` adds `ghCliClient({ run? })`, a `GitHubClient` that sends each request through `gh api`, for tools that already rely on a signed-in `gh`. It spawns `gh` without a shell, rejects HTTP failures with `HttpError`, and throws `NO_GITHUB_CREDENTIALS` when `gh` is missing or signed out. `run` replaces the process runner in tests.

## Options

`status`, `plan`, and `setup` take the same `Options`. `setup` also takes `confirm`.

| Option                   | Default                                                 | Description                                                                                                                         |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`              | required                                                | Google Cloud project ID                                                                                                             |
| `repo`                   | required                                                | `owner/name`                                                                                                                        |
| `google`                 | `defaultGoogleClient()`                                 | A `GoogleAuth`                                                                                                                      |
| `github`                 | `defaultGitHubClient()`                                 | A `GitHubAuth`, or `false` to skip GitHub                                                                                           |
| `presets`                | `'auto'`                                                | Preset names, or `'auto'` to derive them from `firebaseJson` (see `presets.md`)                                                     |
| `firebaseJson`           | `local.firebaseJson`                                    | Parsed `firebase.json`, for `'auto'` presets, when not passing `local`                                                              |
| `roles`                  | `[]`                                                    | Extra project roles on top of the presets                                                                                           |
| `runtimeServiceAccounts` | the project's default compute service account           | With the `functions` preset, the runtime service accounts the deploy service account may act as                                     |
| `names`                  | `github`, `github-<repoId>`, `github-<repoId>`          | `{ pool?, provider?, serviceAccount? }`. Explicit names win over names found through repo variables.                                |
| `variables`              | `FIREBASE_WIF_PROVIDER`, `FIREBASE_WIF_SERVICE_ACCOUNT` | `{ provider, serviceAccount }` repo variable names, or `false` to not manage variables                                              |
| `home`                   |                                                         | `{ provider, serviceAccount }` of an existing trust chain to use instead of the one the variables point at (see `multi-project.md`) |
| `environment`            | `{ name: 'production', branch: <default branch> }`      | `{ name, branch? }`, where `branch: false` lets any branch deploy, or `false` to skip the environment                               |
| `prune`                  | `false`                                                 | Remove unrequested project roles from a service account firebase-wif manages                                                        |
| `adopt`                  | `false`                                                 | Reuse a setup found through legacy repo variables: `true`, or a function `(candidate) => boolean \| Promise<boolean>` that decides  |
| `local`                  |                                                         | `LocalFiles` from `resolveContext`; enables the local checks and the workflow check                                                 |
| `onEvent`                |                                                         | Called with each `ProgressEvent`                                                                                                    |
| `signal`                 |                                                         | Cancels the call                                                                                                                    |
| `sleep`                  | real timers                                             | Used for polling and retry delays; tests pass a no-op                                                                               |
| `confirm` (`setup` only) | always apply                                            | `(plan) => boolean \| Promise<boolean>`, called with the plan before anything is written; return `false` to cancel                  |

Every name is validated before any request, and an invalid one throws `INVALID_NAME`.

## Results

```ts
interface StatusReport {
  ok: boolean; // no check has status 'fail'
  context: Context;
  checks: Check[];
  changes: Change[]; // what setup would do, including manual steps
  preflight: Preflight;
}

interface Plan {
  context: Context;
  changes: Change[];
  preflight: Preflight;
  apply(options?: { signal?: AbortSignal }): Promise<ApplyResult>;
}

interface ApplyResult {
  applied: Change[];
  manual: Change[]; // left for a person, such as variables without GitHub access
  status: StatusReport; // re-run after applying
}

type SetupResult = (ApplyResult & { cancelled: false }) | { cancelled: true; plan: Plan };

// The reconcile resources, in apply order; see reconcile.md
type ResourceId =
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

// Every check; see checks.md
type CheckId =
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

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

interface Check {
  id: CheckId;
  status: CheckStatus;
  message: string;
  fix?: string;
}

type ChangeAction = 'create' | 'update' | 'undelete' | 'enable' | 'bind' | 'unbind' | 'set';

interface Change {
  resource: ResourceId;
  action: ChangeAction;
  description: string;
  manual?: boolean; // can't be applied with the given access; description says what to do by hand
}

interface Preflight {
  missingPermissions: string[];
  githubAdmin: boolean | undefined; // undefined when GitHub is skipped
}

interface Context {
  projectId: string;
  projectNumber: string;
  repo: string;
  repoId: number;
  ownerId: number;
  defaultBranch: string;
  pool: string; // full resource name
  provider: string; // full resource name
  serviceAccount: string; // email
  homeProjectId: string; // differs from projectId when another project holds the trust chain
  variables: { provider: string; serviceAccount: string } | false;
  environment: { name: string; branch: string | false } | false;
  presets: PresetName[];
  roles: string[]; // resolved from presets and roles
  apis: string[];
  runtimeServiceAccounts: string[]; // empty without the functions preset
  adopted?: AdoptCandidate; // set when names come from legacy variables
}

interface AdoptCandidate {
  provider: string;
  serviceAccount: string;
  variables: { provider: string; serviceAccount: string }; // the variable names they came from
}

interface LocalFiles {
  firebaseJson?: Record<string, unknown>;
  firebaserc?: { projects?: Record<string, string> };
  gitignore?: string;
  workflows?: Record<string, string>; // contents keyed by path, like '.github/workflows/deploy.yml'
}

type ProgressEvent =
  | { type: 'check'; check: Check }
  | { type: 'change:start' | 'change:done'; change: Change }
  | { type: 'operation:wait'; name: string; attempt: number }
  | { type: 'retry'; reason: string; attempt: number; delayMs: number };
```

Results are plain data and safe to serialize with `JSON.stringify`, except `Plan.apply`. The CLI's `--json` output is exactly these objects.

## Errors

Every error the library throws on purpose is a `FirebaseWifError`, with a `code`, a human `message`, an optional `fix` (usually a command to run), and `details` typed by its code:

| Code                           | Thrown when                                                                                 | `details`                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `NO_GOOGLE_CREDENTIALS`        | No Google credentials were passed or found                                                  | `undefined`                                                     |
| `NO_GITHUB_CREDENTIALS`        | No GitHub credentials were found, or `gh` is missing or signed out                          | `undefined`                                                     |
| `INVALID_NAME`                 | A project ID, repo, pool, provider, service account, role, variable, or preset is invalid   | `undefined`                                                     |
| `PROJECT_NOT_FOUND`            | The project can't be read                                                                   | `undefined`                                                     |
| `REPO_NOT_FOUND`               | The repo can't be read, or a remote isn't on github.com                                     | `undefined`                                                     |
| `MISSING_PERMISSIONS`          | Applying Google Cloud changes without the permissions they need, before anything is written | `{ missingPermissions: string[] }`                              |
| `PROVIDER_OWNED_BY_OTHER_REPO` | The provider trusts another repository or another issuer                                    | `ApplyFailure` when applying, otherwise `undefined`             |
| `ORG_POLICY_BLOCKS_ISSUER`     | An organization policy doesn't allow GitHub's OIDC issuer                                   | `ApplyFailure`                                                  |
| `OPERATION_TIMEOUT`            | A long-running Google operation didn't finish in time                                       | `ApplyFailure`                                                  |
| `APPLY_FAILED`                 | Any other write failed                                                                      | `ApplyFailure`                                                  |
| `VERIFY_FAILED`                | `verifyCredentials` couldn't exchange the token                                             | `{ stage: 'oidc' \| 'sts' \| 'impersonation'; status: number }` |

`ApplyFailure` is `{ failed: Change; applied: Change[] }`: `failed` is the change that failed and `applied` is every change made before it. Every step is safe to repeat, so the recovery is to fix the cause and run `setup` again.

The table is the `ErrorDetails` type, keyed by `ErrorCode`, and `FirebaseWifError<C extends ErrorCode>` has `code: C` and `details: ErrorDetails[C]`. `isFirebaseWifError(error, 'MISSING_PERMISSIONS')` narrows to that code, so `error.details.missingPermissions` needs no cast.

`HttpError` (with a numeric `status`) is what the built-in clients and the fakes reject with; callers only see it through their own clients. Cancellation rejects with the platform's `AbortError`. Any other error is a bug.

## Other entry points

- **`/presets`**: the role and API sets per product, and the functions that resolve them. `rolesFor({ presets, roles })` returns the deduplicated, sorted roles; `apisFor(presets)` includes `BASE_APIS`. See `presets.md`.
- **`/credentials`**: `createCredentialsConfig({ provider, serviceAccount, audience?, requestUrl, requestToken })` builds the `external_account` credentials the Action writes, and `verifyCredentials(config, { signal?, fetch? })` does one full token exchange, with timeouts and retries. `parseProviderName(name)` splits a provider resource name into `{ projectNumber, pool, provider }`. None of them reads the environment. See `action.md`.
- **`/testing`**: in-memory backends for every Google Cloud and GitHub endpoint the engine uses, so integrations can be tested without mocking HTTP.
  - `createFakeGoogle(seed?)` and `createFakeGitHub(seed?)` implement `GoogleClient` and `GitHubClient`. Each exposes its mutable `state` and the `calls` it received.
  - They model what the engine depends on: soft deletes, etags, IAM calls answering 403 while the IAM API is off, URL fragments that answer 403 (`forbidden`), one-off injected failures (`failures`), long-running operations that need polling (`pendingPolls`), and the provider org policy (`allowedIssuers`).
  - `createConfiguredFakes(options?)` returns fakes that `status` reports as fully set up with the default names, plus matching `options` and resource `names`, so tests start from a passing state and break one thing.

## Compatibility

Exported functions and their signatures, exported types, `Options` fields and defaults, `Check.id` values, `Change.action` values, `FirebaseWifError.code` values, and the `details` shapes above are public API. Changing or removing them is a breaking change under the versioning rules in `release-and-ci.md`. `message`, `fix`, and `Change.description` strings are for people and may change in any release; code should branch on `code`, `id`, and `action`.

These are additions, not breaking changes, and may come in a minor release: new fields on results and options, and new members of `CheckId`, `ResourceId`, `ChangeAction`, and `ErrorCode`. Code that switches over those unions should handle values it doesn't know.

## Security

- Never surface a token in a result, event, or error, and wrap errors from injected clients instead of passing them through.
- Never read the environment, run a command, or touch the filesystem unless the caller called `resolveContext` or relied on a default client.
- Never write before confirming: `setup` checks permissions and calls `confirm` before the first write, and `apply` re-reads each resource before writing it.
- Validate every name before using it in a URL, so caller input can't change which resource a request touches.

## How it's tested

- `test/index.test.ts` checks the contract: importing each entry point has no side effects; `status` and `setup` never print, exit, or read the environment (asserted with spies and a proxy on `process.env`); only context resolution reads the filesystem; a signal stops a run; no report, event, or error contains a token (seeded with sentinel tokens); the exact list of values each entry point exports; and that `FirebaseWifError` is the same class in every entry point.
- `test/structure.test.ts` checks that `src/cli/` imports only from the public entry points, and `src/action/` only from `/credentials`.
- `test/core/types.test.ts` checks the public types with `expectTypeOf`: that existing clients and token shorthands are accepted, which `Options` fields are required, that `resolveContext`'s result spreads into `Options`, that `isFirebaseWifError` and `SetupResult.cancelled` narrow, and how events, check IDs, and statuses are typed.
- `test/consumer/` compiles a consumer program against the built `.d.ts` files (`npm run typecheck:consumer`, after the build in CI), so a breaking type change fails CI.
- The engine tests (`test/core/engine/`) run `status`, `plan`, and `setup` against the `/testing` fakes; see `reconcile.md`.
- `test/presets.test.ts`, `test/credentials.test.ts`, `test/gh.test.ts`, and `test/testing/` cover the other entry points, including that the fakes behave like the real APIs in the ways the engine depends on.
