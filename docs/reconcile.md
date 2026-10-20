# Reconcile

Code: `src/core/engine/`, `src/core/resources/`, `src/core/io/`
Tests: `test/core/engine/`, `test/core/resources/`, `test/core/io/`

`status`, `plan`, and `setup` share one engine. Each piece of the trust chain (see `trust-chain.md`) is a reconcile resource with two halves: `evaluate` reads the current state and returns the changes needed, and `apply` makes them. `status` runs only `evaluate`, and reports a resource with changes as a failed (or warning) check; `setup` runs `evaluate` and then `apply`. Because both use the same `evaluate`, `status` can't pass while `setup` still has work to do, and `setup` can't skip something `status` complains about.

## Resources

In the order `setup` applies them:

| Resource                 | Creates or fixes                                                                              | Severity | Scope       |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------- | ----------- |
| `gcp.apis`               | Enables the APIs that are off, in one batch                                                   | fail     | project     |
| `gcp.pool`               | Creates the pool, restores it if soft-deleted, re-enables it if disabled                      | fail     | trust chain |
| `gcp.provider`           | Creates the provider, restores it if soft-deleted, re-enables it, fixes the required mappings | fail     | trust chain |
| `gcp.provider-condition` | Adds or tightens the attribute condition                                                      | fail     | trust chain |
| `gcp.service-account`    | Creates the service account, or enables it if disabled                                        | fail     | trust chain |
| `gcp.project-roles`      | Grants the missing roles; with `--prune`, removes unrequested ones                            | fail     | project     |
| `gcp.wi-user`            | Lets the repository act as the service account                                                | fail     | trust chain |
| `gcp.runtime-sa-user`    | Lets the service account act as each functions runtime service account                        | fail     | project     |
| `gh.variables`           | Creates or updates the repo variables                                                         | fail     | trust chain |
| `gh.environment`         | Creates the environment and its deployment branch policy                                      | warn     | trust chain |

The severity is the check status when the resource needs changes. `gcp.runtime-sa-user` only exists with the `functions` preset. In a project that reuses another project's trust chain, only `project` resources are reconciled (see `multi-project.md`).

Each change has an action (`create`, `update`, `undelete`, `enable`, `bind`, `unbind`, or `set`) and a description that says exactly what will happen, such as `grant roles/firebasehosting.admin on demo-project to github-123@demo-project.iam.gserviceaccount.com`.

## Reading

Each read ends in one of three ways:

- Found: the resource's current state.
- Missing: Google or GitHub answered 404, so the resource needs creating.
- Skipped: anything else, with the reason. A 403 reads as `insufficient permission`, and other failures carry their status and message.

A resource that can't be read reports `skipped` with the reason instead of failing the run, so one unreadable piece never hides the rest of the report. Reads are shared between resources and checks within one run, so each resource is fetched once.

While the IAM API is disabled, every IAM read is skipped as `blocked by gcp.apis (iam.googleapis.com is disabled)` instead of being attempted, because IAM answers 403 for everything until the API is on.

## `status`

1. Validate every name.
2. Get the clients, then look up the repository (`REPO_NOT_FOUND` if it can't be read) and the project number (`PROJECT_NOT_FOUND`).
3. Read the repo variables, decide whether to adopt a legacy setup, and work out the names (see `trust-chain.md`).
4. Run the permission preflight (see `context-and-credentials.md`).
5. Evaluate every resource and run every advisory check (see `checks.md`) concurrently.

The report's `changes` are every resource's changes in apply order, including manual ones. `ok` is false when any check failed. `status` never writes.

## `plan`

`plan` runs the same evaluation as `status` and returns the ordered changes with an `apply` bound to them. When a resource can't be set up safely, such as a provider that trusts another repository or another issuer, `plan` throws `PROVIDER_OWNED_BY_OTHER_REPO` instead of returning a plan.

The plan only lists changes `evaluate` can see. While the IAM API is off, the pool, provider, and service account can't be read, so the plan shows enabling the APIs and `apply` finds the rest.

## `apply`

1. If any change touches Google Cloud and the preflight found missing permissions, throw `MISSING_PERMISSIONS` with the list before writing anything.
2. For each resource in order, read it again and evaluate it, then apply the changes firebase-wif can make itself. Reading again right before writing means a stale plan never overwrites newer state, and steps the plan couldn't see are applied too.
3. After applying a resource, evaluate it once more and apply again if it still has changes. That covers follow-up changes, such as fixing a provider's mappings right after restoring it.
4. Collect manual changes instead of applying them.
5. Run `status` again and return it with the applied and manual changes.

Each change emits `change:start` before and `change:done` after it's applied.

### Long-running operations

Pool, provider, and API changes return long-running operations. `apply` polls each one every 2 seconds, emitting `operation:wait`, for up to 60 seconds, then fails with `OPERATION_TIMEOUT`.

### IAM policies

Project and service account policies are changed with read-modify-write:

- Read the policy with `requestedPolicyVersion: 3`, change only unconditional bindings, and write it back with its `version` and `etag`, so conditional bindings and concurrent changes are never lost.
- Add only missing members, and remove members only for `--prune`. A binding left with no members is dropped.
- When the write conflicts (409 or `ABORTED`), read again and retry, up to 5 times, waiting 1, 2, 3… seconds plus up to half a second of jitter.
- A service account created in the same run can be unknown to IAM for a short time. Only then, 400 and 404 answers are retried up to 5 times, 5 seconds apart.

Each retry emits `retry` with the reason, attempt, and delay. The `sleep` option controls the waiting, so tests run without real delays.

### Partial failure

When a write fails, `apply` stops and throws: `APPLY_FAILED`, or a more specific code such as `OPERATION_TIMEOUT` or `ORG_POLICY_BLOCKS_ISSUER`, with `details.failed` (the change that failed) and `details.applied` (everything applied before it). The message says both. Every step is safe to repeat, so the recovery is always to fix the cause and run `setup` again.

When creating the provider fails because of the `constraints/iam.workloadIdentityPoolProviders` organization policy, the error explains the constraint and the issuer it needs to allow.

## `setup`

`setup` is `plan`, then the permission check from `apply`, then `confirm(plan)`, then `apply`. Checking permissions before confirming means a caller is never asked to approve a run that can't succeed. When `confirm` returns false, `setup` returns `{ cancelled: true, plan }` and writes nothing.

## Rules

- **Never loosen or delete.** `setup` only adds or tightens. Extra grants, legacy secrets, and service account keys are reported by checks and left for the user to remove.
- **`--prune` is the one exception.** It removes the deploy service account from unconditional project role bindings that aren't requested, and only when the account carries the `Managed by firebase-wif` marker. It never touches conditional bindings or other members. On an account without the marker it changes nothing, and the `gcp.extra-roles` check says why.
- **`--any-branch` removes a branch policy only because it was asked for.** It sets the environment to allow any branch, keeping its reviewers and wait timers.
- **No GitHub access means manual steps.** Without GitHub credentials, the variables and environment become manual changes with exact descriptions. Without repo admin access, GitHub changes become manual too, with the fix `Ask a repo admin to run firebase-wif setup, or make these changes by hand.`

## Environment

`gh.environment` creates the environment, or updates it when its deployment branch policy isn't "selected branches only", then adds a branch policy for the deploy branch if there isn't one. Other branch policies are never removed. GitHub's environment update drops protection rules it isn't sent, so `apply` sends the current reviewers, wait timer, and self-review setting back with every update.

With `--any-branch`, the environment is correct when it has no deployment branch policy, and `apply` removes one if it's there.

## Adopting a legacy setup

Repositories set up by older scripts keep their provider and service account in other variables. When adoption is enabled, `status` and `setup` look for one:

1. Adoption is only considered while neither of the expected variables exists, GitHub is available, variables are enabled, and no `home` is passed.
2. List the repo's variables and look for a known pair first: `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SA`, then `WIF_PROVIDER` and `DEPLOY_SERVICE_ACCOUNT`. Otherwise, take any variable whose value is a provider name in this project and any variable whose value is a service account email in this project.
3. With `adopt: true`, use the candidate. With a function, call it with the candidate and use it if it returns true.

Adopting reuses the provider and service account, writes the expected variables with their values, and leaves the legacy variables untouched. An adopted provider whose condition only matches `owner/name` gets tightened to the ID condition like any other. `adopt` defaults to `false` in the API; the CLI asks.

## Security

- Never write during `status` or `plan`.
- Never write before the permission check and confirmation.
- Never loosen or delete, except `--prune` on a managed account and `--any-branch` on the environment it names.
- Never re-point another repository's provider.
- Never lose a conditional binding, another member, or a concurrent policy change: always read-modify-write with the `etag`.

## How it's tested

- `test/core/engine/engine.test.ts` runs `status`, `plan`, and `setup` against the `/testing` fakes with a no-op `sleep`. It covers each resource from missing, soft-deleted, disabled, drifted, correct, and unreadable states; that applying twice leaves an empty second plan; that `status` fails exactly when the plan has changes; retries for conflicts and for a just-created service account; operation polling and timeout; abort; partial failure; the organization policy error; prune on managed and unmanaged accounts; adoption; manual changes without GitHub access or admin; and environment protection rules being kept.
- `test/core/resources/` evaluates each resource directly in each of its states, one test file per resource.
- `test/core/io/writes.test.ts` covers polling, retry limits and delays, and policy read-modify-write.
- `test/core/io/reads.test.ts` and `google-reads.test.ts` cover reads, shared reads, and the IAM-blocked state.
- `test/core/engine/adopt.test.ts` covers finding a legacy pair; `apply.test.ts`, `inspect.test.ts`, and `permissions.test.ts` cover the engine's parts directly.
