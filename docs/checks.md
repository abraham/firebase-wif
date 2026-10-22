# Checks

Code: `src/core/checks/`, `src/core/resources/`, `src/core/engine/catalog.ts`
Tests: `test/core/checks/`, `test/core/engine/catalog.test.ts`, `test/core/engine/engine.test.ts`

`status` reports one check per line. Each has a stable ID, a status (`pass`, `warn`, `fail`, or `skipped`), a one-line message, and, when it didn't pass, a fix: usually `firebase-wif setup`, or the exact command or change to make.

There are two kinds:

- Reconcile checks are the `evaluate` half of a reconcile resource (see `reconcile.md`). They fail (or warn) exactly when `setup` has changes for them, so their fix is `firebase-wif setup`.
- Advisory checks have no setup step. They report things firebase-wif won't change, such as leftover keys, and their fix says what to do by hand.

## Statuses

- `pass`: correct.
- `fail`: deploys won't work until it's fixed. Any failed check makes `ok` false and the CLI exit 1.
- `warn`: deploys can work, but something is risky, untidy, or will block `setup`.
- `skipped`: the check couldn't run, with the reason in the message: no local files were given, a dependency isn't there yet (`blocked by gcp.apis`, `service account doesn't exist yet`), firebase-wif lacks permission to read it (`insufficient permission`), GitHub credentials are missing, or another project holds the trust chain (`shared from <home>`). A skipped reconcile check whose changes are manual lists them as its fix.

A reconcile check whose resource can't be set up safely, such as a provider that trusts another repository, fails with a fix that explains why instead of `firebase-wif setup`.

## Catalog

Checks are listed in report order. Reconcile checks are marked with an asterisk.

### Local

These run only when local files are passed (the CLI always passes them).

| ID                    | Passes when                                                                                                                                                                                                                           | Otherwise                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `local.firebase-json` | `firebase.json` was found                                                                                                                                                                                                             | warn                                      |
| `local.project-match` | The project is the `.firebaserc` default or one of its aliases                                                                                                                                                                        | warn, with `firebase use --add <project>` |
| `local.creds-ignored` | No workflow writes `google-github-actions/auth` credential files into the workspace, or those files (`gha-creds-*.json`) are in `.gitignore` and in the `ignore` list of every Hosting site whose `public` directory is the repo root | warn                                      |

### Google Cloud

| ID                         | Passes when                                                                                                                                                                                                          | Otherwise                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `gcp.project`              | The project is readable and its number is known. When it isn't, the run stops with `PROJECT_NOT_FOUND` instead of reporting.                                                                                         | —                                                                                                   |
| `gcp.operator`             | The person running firebase-wif has every permission `setup` needs (see `context-and-credentials.md`)                                                                                                                | warn, listing the missing permissions                                                               |
| `gcp.apis`\*               | Every required API is enabled                                                                                                                                                                                        | fail                                                                                                |
| `gcp.pool`\*               | The pool exists, is active, and isn't disabled                                                                                                                                                                       | fail                                                                                                |
| `gcp.provider`\*           | The provider exists, is active, isn't disabled, trusts GitHub's issuer, and maps the required attributes. Another issuer fails with a fix to use `--provider`.                                                       | fail                                                                                                |
| `gcp.provider-condition`\* | The condition pins this repository's ID (see `trust-chain.md`). Another repository's provider fails with a fix to use `--provider`. Skipped until the provider exists.                                               | fail                                                                                                |
| `gcp.service-account`\*    | The service account exists and isn't disabled                                                                                                                                                                        | fail                                                                                                |
| `gcp.sa-keys`              | The service account has no user-managed keys                                                                                                                                                                         | warn, with the key count                                                                            |
| `gcp.project-roles`\*      | The service account has every requested role in an unconditional binding (and, with `--prune`, no unrequested ones on a managed account)                                                                             | fail                                                                                                |
| `gcp.extra-roles`          | The service account has no unconditional project roles beyond the requested ones                                                                                                                                     | warn, with `firebase-wif setup --prune` as the fix for a managed account, or a manual fix otherwise |
| `gcp.wi-user`\*            | This repository's principal set has `roles/iam.workloadIdentityUser` on the service account                                                                                                                          | fail                                                                                                |
| `gcp.wi-user-broad`        | No other workload identity principal (a whole pool, or another repository) has `roles/iam.workloadIdentityUser` or `roles/iam.serviceAccountTokenCreator` on the service account                                     | warn                                                                                                |
| `gcp.runtime-sa-user`\*    | With the `functions` preset only: the service account has `roles/iam.serviceAccountUser` on each runtime service account. A runtime account that doesn't exist yet is ignored; the check is skipped when none exist. | fail                                                                                                |

`gcp.extra-roles` is also how a project-level `roles/iam.serviceAccountUser`, or roles an older setup granted, show up. With `--prune` on an account firebase-wif doesn't manage, its message says the roles weren't pruned and why.

### GitHub

| ID                  | Passes when                                                                                                                                                                                                                       | Otherwise                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `gh.repo`           | The repository is readable and the person running firebase-wif is a repo admin. When it isn't readable, the run stops with `REPO_NOT_FOUND`.                                                                                      | warn when not an admin, because `setup` can't change variables or environments |
| `gh.variables`\*    | Both repo variables exist and equal the provider name and service account email                                                                                                                                                   | fail                                                                           |
| `gh.environment`\*  | The environment exists and only the deploy branch can deploy to it, or, with `--any-branch`, any branch can. Skipped with `--no-environment`. When there's a preview environment, it also exists and any branch can deploy to it. | warn                                                                           |
| `gh.legacy-secrets` | No `FIREBASE_SERVICE_ACCOUNT*`, `FIREBASE_TOKEN`, or `GCP_SA_KEY` secrets remain (names only; values are never read)                                                                                                              | warn, with the secret names                                                    |
| `gh.oidc-sub`       | The job's `sub` claim fits Google's 127-byte `google.subject` limit (see below)                                                                                                                                                   | warn                                                                           |
| `gh.workflows`      | Every local workflow job that deploys to Firebase can get an OIDC token and uses an auth step (see below)                                                                                                                         | warn, listing each job's problems                                              |

### `gh.oidc-sub`

Google rejects a mapped `google.subject` longer than 127 bytes, and the provider maps it from the `sub` claim. The check reads the repository's `sub` template and estimates the longest `sub` among the contexts that deploy: a push to the deploy branch, a pull request, and each environment. Customizing the template never breaks trust, which is pinned to the repository ID; the check only warns when the estimate is over the limit. Claims whose values can't be known in advance are estimated at 40 bytes.

### `gh.workflows`

A job deploys to Firebase when a step uses `FirebaseExtended/action-hosting-deploy` or `w9jds/firebase-action`, or runs `firebase deploy` or `firebase hosting:channel:deploy` (also through `firebase-tools`). A step deploys live when it runs `firebase deploy`, passes `deploy` to `w9jds/firebase-action`, or sets `channelId: live` on `action-hosting-deploy`. It deploys to a preview channel when it runs or passes `hosting:channel:deploy`, or uses `action-hosting-deploy` with any other `channelId`. A job with a live step deploys live; a job whose steps all deploy to preview channels is a preview job. When it can't tell, such as a `channelId` expression that mentions `live`, it doesn't check the job's environment. Each deploy job should:

- Have `permissions: id-token: write`, on the job or the workflow, or `write-all`.
- When the workflow runs on `pull_request` or `pull_request_target`, have a same-repo guard (`if:` comparing `head.repo.full_name`, or checking `head.repo.fork`), because fork pull requests can't get OIDC tokens.
- Use `abraham/firebase-wif` or `google-github-actions/auth`.
- Use the deploy environment when it deploys live, and the preview environment when it's a preview job. A preview job in a deploy environment that only the deploy branch can deploy to is always flagged, because pull requests can't deploy from it. Environments given as expressions aren't checked, and nothing is checked for an environment that's skipped.

It's skipped when no workflow deploys to Firebase, and warns with the file names when a workflow isn't valid YAML.

## Compatibility

Check IDs, which checks are reconcile checks, and their severities are public API: changing them is a breaking change. Messages and fixes may change in any release.

## Security

- Never read secret values; `gh.legacy-secrets` reads names only.
- Never write while checking.
- A check that can't read something says so (`skipped`) instead of guessing that it's correct.

## How it's tested

- `test/core/checks/local.test.ts`, `gcp.test.ts`, and `github.test.ts` run each advisory check against the `/testing` fakes in passing, warning, and skipped states.
- `test/core/checks/workflows.test.ts` covers deploy detection, telling live deploys from preview channel deploys, each workflow problem including the wrong environment, credential files in the workspace, and invalid YAML.
- `test/core/checks/oidc.test.ts` covers the `sub` estimate for the default and customized templates, in bytes rather than characters.
- `test/core/engine/catalog.test.ts` checks the report order; `test/core/engine/engine.test.ts` checks that reconcile checks fail exactly when the plan has changes, and the skipped reasons.
