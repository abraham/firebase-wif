# Context and credentials

Code: `src/core/context.ts`, `src/core/clients.ts`, `src/core/engine.ts`, `src/gh.ts`
Tests: `test/core/context.test.ts`, `test/core/clients.test.ts`, `test/gh.test.ts`, `test/core/engine.test.ts`

Before it can check or change anything, firebase-wif needs to know which project and repository to work on, and needs credentials for Google Cloud and GitHub. Discovery and credential lookup are the only places firebase-wif reads the filesystem, the environment, or runs other commands, and the library only does them when asked (see `node-api.md`).

## Discovering the project and repository

`resolveContext({ cwd, project, repo, env, exec })` works from a directory, `cwd` by default the current one.

### Files

1. The git root is the nearest directory at or above `cwd` with a `.git` entry.
2. The Firebase directory is the nearest directory at or above `cwd`, up to the git root, with a `firebase.json` or `.firebaserc`.
3. `firebase.json` and `.firebaserc` are read from the Firebase directory. A file that exists but isn't valid JSON fails with `INVALID_NAME` ("`<path>` is not valid JSON").
4. `.gitignore` and the workflow files (`.github/workflows/*.yml` and `*.yaml`, in name order) are read from the git root, or the Firebase directory, or `cwd`.

These become `LocalFiles`, which the local checks and the workflow check use (see `checks.md`). Missing files are fine; their checks warn or skip.

### Project

The first of these that applies:

1. `project`: an alias in `.firebaserc` `projects`, or else a project ID.
2. The `default` project in `.firebaserc`.
3. `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`.

With none, it fails with `PROJECT_NOT_FOUND` and the fix `Pass --project, or add a default project to .firebaserc.`

### Repository

The first of these that applies:

1. `repo`.
2. `GITHUB_REPOSITORY`.
3. The `origin` git remote, in https, ssh, or scp form (`git@github.com:owner/name.git`). A remote on any host other than github.com fails with `REPO_NOT_FOUND`, because GitHub Enterprise Server isn't supported.
4. `gh repo view`.

With none, it fails with `REPO_NOT_FOUND` and the fix `Pass --repo owner/name.`

### Sources

`sources` says where the project and repo came from, for display: `--project`, `.firebaserc alias <name>`, `.firebaserc default`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `--repo`, `GITHUB_REPOSITORY`, `git remote origin`, or `gh repo view`.

### Aliases

For `--all-aliases`, the projects in `.firebaserc` are listed once each, under their first alias, with `default` first (see `multi-project.md`).

## Credentials

### Google Cloud

When no Google client or token is passed, the first of these that works is used:

1. The `GOOGLE_OAUTH_ACCESS_TOKEN` environment variable.
2. `gcloud auth print-access-token`. The token is fetched again after 50 minutes, since gcloud tokens last an hour.
3. Application Default Credentials, through `google-auth-library` with the `cloud-platform` scope. The library is an optional dependency, imported only when this step runs.

With none, it fails with `NO_GOOGLE_CREDENTIALS` and the fix `gcloud auth login`.

### GitHub

When no GitHub client or token is passed, the first of these that works is used:

1. The `GH_TOKEN` environment variable, then `GITHUB_TOKEN`.
2. `gh auth token`.

With none, it fails with `NO_GITHUB_CREDENTIALS` and the fix `gh auth login`. The CLI doesn't stop there: it continues with `github: false`, so the repository is looked up without credentials and every GitHub change becomes a manual step.

Callers can also pass a client of their own, a token, or `ghCliClient()`, which sends each request through a signed-in `gh` (see `node-api.md`).

### Clients

The built-in clients call the REST APIs directly with `fetch`; `gcloud` and `gh` are only ever credential sources.

- The Google client sends `Authorization: Bearer <token>`, getting the token for each request so it can refresh.
- The GitHub client calls `https://api.github.com` with `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, a `firebase-wif` user agent, and the token when there is one.
- Both reject HTTP failures with `HttpError`, using the error message from the response body.

## Looking up the project and repository

Every run starts by reading:

- The repository (`GET /repos/<owner>/<name>`), for its numeric ID, owner ID, default branch, and whether the caller is an admin. If it can't be read, the run fails with `REPO_NOT_FOUND`; without credentials, the fix says private repositories need them.
- The project (`GET` on Resource Manager), for its number. If it can't be read, the run fails with `PROJECT_NOT_FOUND`.

## Permission preflight

Before planning, firebase-wif asks Google which of the permissions `setup` will use the caller has (`testIamPermissions` on the project):

- In a home project, `SETUP_PERMISSIONS`: `iam.serviceAccounts.create`, `iam.serviceAccounts.setIamPolicy`, `iam.workloadIdentityPools.create`, `iam.workloadIdentityPools.undelete`, `iam.workloadIdentityPoolProviders.create`, `iam.workloadIdentityPoolProviders.update`, `iam.workloadIdentityPoolProviders.undelete`, `resourcemanager.projects.setIamPolicy`, and `serviceusage.services.enable`.
- In a project that reuses another project's trust chain, `CROSS_PROJECT_PERMISSIONS`: `iam.serviceAccounts.setIamPolicy`, `resourcemanager.projects.setIamPolicy`, and `serviceusage.services.enable`.

If the call itself fails, every permission counts as missing. The result is `preflight.missingPermissions`, reported by the `gcp.operator` check, and `apply` refuses to write to Google Cloud while any are missing. On GitHub, `preflight.githubAdmin` is whether the caller is a repo admin (`undefined` without GitHub).

To run `status`, the caller needs read access: the project's IAM policy, the pool and provider, the service account, its keys and policy, and the enabled services. Without some of these, the affected checks are skipped as `insufficient permission`. Reading repo variables, environments, and secret names needs repo admin or a token with those read scopes. To run `setup`, the caller needs project Owner, or the Workload Identity Pool Admin, Service Account Admin, Project IAM Admin, and Service Usage Admin roles, plus repo admin on GitHub.

## Security

- Never print, return, or include token values in errors.
- Run `gcloud`, `gh`, and `git` with `execFile`, never through a shell.
- Read only the files listed above, and only inside the git root or Firebase directory.
- Never write to the filesystem.
- Only send each token to its own API: the Google token to Google, the GitHub token to `api.github.com`.

## How it's tested

- `test/core/context.test.ts` uses temporary directories to cover the search for the git root and Firebase directory, every project and repository source in order, alias resolution, remote formats, other hosts, invalid JSON, the files read into `LocalFiles`, and alias listing.
- `test/core/clients.test.ts` covers both credential lookups in order, gcloud token refresh, Application Default Credentials (with `google-auth-library` mocked), the clients' requests and headers, and error mapping.
- `test/gh.test.ts` covers `ghCliClient` with a fake process runner.
- `test/core/engine.test.ts` covers the repository and project lookups, the preflight for home and cross-project runs, and `apply` refusing to write with missing permissions.
