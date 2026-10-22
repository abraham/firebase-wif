---
name: firebase-wif
description: 'Update GitHub Actions workflow YAML files to deploy to Firebase with the abraham/firebase-wif Action (Workload Identity Federation, OIDC) instead of service account keys, FIREBASE_TOKEN, GCP_SA_KEY, or FIREBASE_SERVICE_ACCOUNT secrets. Use when migrating or adding Firebase deploys in .github/workflows that use firebase-tools, firebase deploy, hosting:channel:deploy, FirebaseExtended/action-hosting-deploy, w9jds/firebase-action, or google-github-actions/auth.'
argument-hint: 'Optional workflow file to update'
---

# Use abraham/firebase-wif in GitHub Actions workflows

Rewrites Firebase deploy jobs to get short-lived Google credentials from the job's OIDC token through `abraham/firebase-wif`, so no key or token secret is needed.

## Before editing

- The Action reads two repo variables that `npx @abraham/firebase-wif setup` creates: `FIREBASE_WIF_PROVIDER` and `FIREBASE_WIF_SERVICE_ACCOUNT`. If `npx @abraham/firebase-wif status` shows them failing, tell the user to run `setup` themselves. Never run `setup` without asking: it changes Google Cloud IAM and GitHub settings.
- Find the latest version with `npm view @abraham/firebase-wif version` (or `gh release view --repo abraham/firebase-wif --json tagName -q .tagName`). Pin the full tag, like `abraham/firebase-wif@v0.2.0`. There are no moving `@v0` tags, and `@main` must never be used for a credentials action.

## Find the deploy jobs

Look in `.github/workflows/*.yml` and `*.yaml` for jobs with a step that:

- uses `FirebaseExtended/action-hosting-deploy` or `w9jds/firebase-action`, or
- runs `firebase deploy`, `firebase hosting:channel:deploy`, or `firebase-tools` (including through `npx`), or
- uses `google-github-actions/auth` before one of those.

Leave jobs that don't deploy to Firebase alone.

## Update each deploy job

1. **Permissions.** Give the job `id-token: write` and `contents: read`. Job-level `permissions` replace the workflow's, so copy over any other permissions the job relied on (for example `pull-requests: write` for action-hosting-deploy's PR comments, or `checks: write`). Don't add `id-token: write` to jobs that don't deploy.
2. **Fork guard.** If the workflow runs on `pull_request` or `pull_request_target`, fork pull requests can't get OIDC tokens. Add `if: github.event.pull_request.head.repo.full_name == github.repository` to the job (combine it with any existing `if:` using `&&`). Use `github.event_name != 'pull_request' || ...` when the job also runs on other events.
3. **Environment.** `setup` creates a `production` environment that only the default branch can deploy to, and, when a workflow deploys to preview channels, a `preview` environment that any branch can deploy to. Add `environment: production` to jobs that deploy live from the default branch (`firebase deploy`, `w9jds/firebase-action` with `deploy`, or `action-hosting-deploy` with `channelId: live`). Add `environment: preview` to jobs that only deploy to preview channels (`hosting:channel:deploy`, or `action-hosting-deploy` without `channelId: live`); never put them in `production`, which blocks pull request branches. If a preview job already uses another environment, keep it: `setup` uses that one instead of `preview`. Re-running `setup` after adding a preview job creates the `preview` environment.
4. **Auth step.** Add the Action after `actions/checkout` (and after any build steps) and before the first deploy step. Give it `id: wif` when a later step needs its outputs:

   ```yaml
   - id: wif
     uses: abraham/firebase-wif@v0.2.0
     with:
       workload_identity_provider: ${{ vars.FIREBASE_WIF_PROVIDER }}
       service_account: ${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}
   ```

   Add `working_directory: <dir>` when `.firebaserc` isn't at the repo root, or `project_id: <id>` to deploy to a project other than the `.firebaserc` default.

5. **Deploy step.** Remove the old credentials and use the Action's instead:

   | Deploy step                              | Change                                                                                                                                                                                              |
   | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `firebase-tools` / `firebase deploy`     | Remove `FIREBASE_TOKEN`, `--token`, and `GOOGLE_APPLICATION_CREDENTIALS` set from a secret. The Action exports the credentials. Keep `--non-interactive`.                                           |
   | `FirebaseExtended/action-hosting-deploy` | `firebaseServiceAccount: ${{ steps.wif.outputs.credentials_json }}`. Set `projectId: ${{ steps.wif.outputs.project_id }}` unless it already names the project.                                      |
   | `w9jds/firebase-action`                  | `GCP_SA_KEY: ${{ steps.wif.outputs.credentials_json }}` and `PROJECT_ID: ${{ steps.wif.outputs.project_id }}` in `env`. Remove `FIREBASE_TOKEN`.                                                    |
   | `google-github-actions/auth`             | Replace that step with the auth step above; the input and output names match. Drop `credentials_json`, `create_credentials_file`, and `export_environment_variables`. See below for `token_format`. |

6. **Clean up.** Delete steps that write a key secret to a file (like `echo "${{ secrets.GCP_SA_KEY }}" > key.json`) and any `GOOGLE_APPLICATION_CREDENTIALS` pointing at such a file. Keep `google-github-actions/setup-gcloud`; `gcloud` picks up the exported credentials.

## Don't

- Don't migrate a step that uses `steps.<auth>.outputs.access_token` or `id_token` (`token_format`); `abraham/firebase-wif` doesn't output tokens. Leave `google-github-actions/auth` there and tell the user.
- Don't echo, upload, or cache `credentials_json` or the credentials file.
- Don't delete repository secrets. List the ones the workflows no longer use (`FIREBASE_TOKEN`, `GCP_SA_KEY`, `FIREBASE_SERVICE_ACCOUNT*`) so the user can remove them after a successful deploy.

## Example

Before:

```yaml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_MY_PROJECT }}
          channelId: live
          projectId: my-project
```

After:

```yaml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v7
      - id: wif
        uses: abraham/firebase-wif@v0.2.0
        with:
          workload_identity_provider: ${{ vars.FIREBASE_WIF_PROVIDER }}
          service_account: ${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          repoToken: ${{ secrets.GITHUB_TOKEN }}
          firebaseServiceAccount: ${{ steps.wif.outputs.credentials_json }}
          channelId: live
          projectId: my-project
```

## Verify

1. Run `npx @abraham/firebase-wif status`. The `gh.workflows` check ("Deploy workflows") should pass; it flags deploy jobs missing `id-token: write`, the fork guard, an auth step, or the right environment. The `gh.environment` check should show the `preview` environment when there's a preview job; if it doesn't exist yet, tell the user to re-run `setup`.
2. If the deploys now cover more products (Functions, Firestore, Storage), the deploy account needs more roles: `setup` picks them from `firebase.json`, so tell the user to re-run it.
3. Run `actionlint` on the changed files if it's installed.
4. Summarize for the user: the files changed, the version pinned, any steps left on `google-github-actions/auth`, and the secrets they can delete after a successful deploy.
