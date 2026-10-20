# GitHub Action

Code: `action.yml`, `src/action/main.ts`, `src/action/post.ts`, `src/action/core.ts`, `src/credentials.ts`, `dist/action/`
Tests: `test/action/main.test.ts`, `test/action/post.test.ts`, `test/action/core.test.ts`, `test/credentials.test.ts`

`abraham/firebase-wif` turns the job's GitHub OIDC token into Google credentials for a service account. It writes a Google `external_account` credentials file and points the environment at it, so any Google client library, including `firebase-tools`, picks it up without a key. It also outputs the file's contents for deploy actions that take a service account JSON string.

The Action doesn't set anything up. `setup` (see `reconcile.md`) creates the provider and service account and writes the repo variables the Action reads.

## Usage

```yaml
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: abraham/firebase-wif@v0.1.0
        with:
          workload_identity_provider: ${{ vars.FIREBASE_WIF_PROVIDER }}
          service_account: ${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}
      - run: npx firebase-tools deploy --only hosting --non-interactive
```

The job needs `id-token: write`. Pull requests from forks can't get OIDC tokens, so jobs that run on pull requests need `if: github.event.pull_request.head.repo.full_name == github.repository`. The README has examples for other deploy tools.

## Inputs

The names use snake_case to match `google-github-actions/auth`, so switching only changes the `uses:` line.

| Input                        | Required | Default                                 | Description                                                                                                   |
| ---------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `workload_identity_provider` | yes      |                                         | Full provider resource name, `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<id>` |
| `service_account`            | yes      |                                         | Service account email                                                                                         |
| `project_id`                 | no       | see below                               | Project ID to export and output                                                                               |
| `working_directory`          | no       | `.`                                     | Where to look for `.firebaserc`, relative to the workspace                                                    |
| `audience`                   | no       | `https://iam.googleapis.com/<provider>` | Audience of the GitHub OIDC token, for providers with custom `allowedAudiences`                               |
| `verify`                     | no       | `true`                                  | Do one token exchange so problems fail in this step, with a fix                                               |
| `export_environment`         | no       | `true`                                  | Export the credential and project environment variables for later steps                                       |

`workload_identity_provider` and `service_account` have no defaults even though `setup` always writes the same repo variables: passing `${{ vars.* }}` explicitly shows anyone reading the workflow which identity it deploys as.

The project ID comes from the `project_id` input, then the `default` project in `.firebaserc` in `working_directory`, then the project number in the provider name, so it always resolves. Most Google APIs accept the number; pass `project_id` when a tool needs the ID.

Boolean inputs accept `true` or `false` in any case; anything else fails the step.

## Outputs

| Output                  | Description                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `credentials_file_path` | Path to the credentials file in `RUNNER_TEMP`                                                        |
| `credentials_json`      | The file's contents as one line of JSON, masked, for actions that take a service account JSON string |
| `project_id`            | The resolved project ID, or the provider's project number                                            |
| `service_account`       | The service account email                                                                            |

## Environment

With `export_environment: true`, later steps get:

| Variable                                                                                            | Value                     |
| --------------------------------------------------------------------------------------------------- | ------------------------- |
| `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, `GOOGLE_GHA_CREDS_PATH` | The credentials file path |
| `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`                                   | The project ID            |

These are the variables Google client libraries, `firebase-tools`, and `gcloud` read, and the ones `google-github-actions/auth` sets.

## Main step

1. Fail unless `GITHUB_SERVER_URL` is `https://github.com`: "Only github.com is supported; GitHub Enterprise Server is not."
2. Fail unless `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are set:
   > Missing OIDC token. Add `permissions: id-token: write` to the job. Pull requests from forks can't get OIDC tokens; guard the job with `if: github.event.pull_request.head.repo.full_name == github.repository`.
3. Mask the request token.
4. Read and validate the inputs. An invalid provider name or service account email fails with `INVALID_NAME`.
5. Build the credentials config and mask its one-line JSON.
6. Resolve the project ID.
7. Fail unless `RUNNER_TEMP` is set and outside `GITHUB_WORKSPACE`, so the file can't end up in a deploy, an artifact, or a commit.
8. Write the config to `$RUNNER_TEMP/firebase-wif-<random UUID>.json` with mode `0600`, refusing to overwrite an existing file, and save its path for the post step.
9. With `verify: true`, verify the credentials (see below).
10. Export the environment variables, then set the outputs.

Steps 1–8 run before any network request, and steps 1–7 before anything is written. A failure ends the step with one `::error::` line (the message, then the fix) and exit code 1. When verification fails, the file has already been written: the post step deletes it, and no outputs or environment variables are set.

## Credentials file

The file is a Google `external_account` config, the format `google-github-actions/auth` writes and Google client libraries read:

```json
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/<provider>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<service account>:generateAccessToken",
  "credential_source": {
    "url": "<ACTIONS_ID_TOKEN_REQUEST_URL with audience=<audience>>",
    "headers": { "Authorization": "Bearer <ACTIONS_ID_TOKEN_REQUEST_TOKEN>" },
    "format": { "type": "json", "subject_token_field_name": "value" }
  }
}
```

A client library using it fetches a fresh OIDC token from GitHub, exchanges it at Google's Security Token Service (STS), and impersonates the service account for a short-lived access token. The `audience` input changes only the OIDC token's audience in `credential_source.url`; the top-level `audience` is always the provider.

## Verification

Verification does the same exchange a client library will, once, so a broken setup fails in this step with a fix instead of deep inside a deploy:

1. Fetch the OIDC token from GitHub.
2. Exchange it at STS for a federated token.
3. Call `generateAccessToken` for the service account.

Each known failure maps to a message and a fix:

| Stage         | Failure                                                                     | Message                                                                                     | Fix                                                                  |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| GitHub token  | The request fails or has no token                                           | Couldn't get an OIDC token from GitHub                                                      | Add `permissions: id-token: write` to the job                        |
| STS           | The error mentions `google.subject`                                         | The job's `sub` claim is longer than the 127-byte `google.subject` limit                    | Use shorter branch or environment names; see the `gh.oidc-sub` check |
| STS           | `invalid_grant` or `unauthorized_client` mentioning the attribute condition | The provider's attribute condition doesn't allow this repository                            | Run `setup`                                                          |
| STS           | `invalid_target`                                                            | The workload identity pool or provider doesn't exist or is disabled                         | Check `workload_identity_provider`, then run `status`                |
| STS           | Anything else                                                               | Google STS rejected the GitHub token, with Google's error                                   | Run `status`                                                         |
| Impersonation | The IAM Service Account Credentials API is off                              | `iamcredentials.googleapis.com` is not enabled                                              | Run `setup`                                                          |
| Impersonation | 403                                                                         | This repository can't act as the service account; it needs `roles/iam.workloadIdentityUser` | Run `setup`                                                          |
| Impersonation | 404                                                                         | The service account doesn't exist                                                           | Check `service_account`, then run `setup`                            |
| Impersonation | Anything else                                                               | Couldn't get an access token, with Google's error                                           | Run `status`                                                         |

Messages quote at most 300 characters of Google's error. The tokens from the exchange are thrown away; they're never logged, output, or exported.

## Post step

The post step reads the saved path and deletes the file. A missing file, or no saved path because the main step failed early, is fine. If deleting fails, it logs a warning and still succeeds, so cleanup never fails a job that deployed.

## Credentials library

`@abraham/firebase-wif/credentials` exposes what the Action uses, for other actions and runners:

- `createCredentialsConfig({ provider, serviceAccount, audience?, requestUrl, requestToken })` builds the config above. It validates the provider name and service account email, and never reads the environment.
- `verifyCredentials(config, { signal?, fetch? })` does the verification above and throws `VERIFY_FAILED` with the message and fix from the table, and `details: { stage, status }`, where `stage` is `oidc`, `sts`, or `impersonation`.

## Runtime and bundling

The Action runs on `node24` with `main: dist/action/main.js` and `post: dist/action/post.js`. Both are esbuild bundles of `src/action/` (ESM, targeting Node 24, with a pinned esbuild version), committed to the repo and left out of the npm package. CI fails when the committed bundles don't match a fresh build.

The Action doesn't depend on `@actions/core`. `src/action/core.ts` implements the parts it needs: reading inputs, the `GITHUB_OUTPUT`, `GITHUB_ENV`, and `GITHUB_STATE` file commands with random delimiters, and the `::add-mask::`, `::warning::`, and `::error::` workflow commands with escaped data. So the bundle contains only this package's code.

## Compatibility

Inputs, outputs, their defaults, the exported environment variable names, and the credentials file format are public API: changing them is a breaking change under the versioning rules in `release-and-ci.md`. Error messages and fixes may change in any release. The credentials file format is Google's, and only changes to follow it.

## Security

- The credentials file and `credentials_json` are secrets for the job's lifetime, because they hold the request token that can mint OIDC tokens until the job ends. Mask the request token and the JSON before anything else is printed, write the file with mode `0600` outside the workspace, and delete it in the post step. Never upload it as an artifact.
- Never log, output, or export an OIDC token, federated token, or access token.
- Never overwrite an existing file, and never write inside `GITHUB_WORKSPACE`.
- Refuse GitHub Enterprise Server, whose OIDC issuer the provider doesn't trust.
- Ship only this package's code in the bundle, and fail CI when the committed bundle doesn't match its source.

## How it's tested

- `test/action/main.test.ts` runs the main step in-process with a fake environment, temporary workspace and `RUNNER_TEMP` directories, and a fake `fetch` for GitHub's token endpoint, STS, and IAM Credentials. It checks the file's contents, mode, and location; the outputs, exported variables, and saved state; that the request token and JSON are masked first and no token appears in the log; the project ID order; `verify` and `export_environment`; every failure before writing; and that a failed verification leaves cleanup to the post step. It also runs the committed `dist/action/main.js` with `node`.
- `test/action/post.test.ts` checks that the file is deleted, that a missing file or missing state is fine, that a failed delete only warns, and runs the committed `dist/action/post.js`.
- `test/action/core.test.ts` checks inputs, the file command format, escaping, masking, and the entry-point check that makes the bundles run on load.
- `test/credentials.test.ts` checks the config format, the `audience` input, name validation, the exact requests verification makes, every row of the error table, that no token appears in an error, and that the abort signal reaches every request.
- CI rebuilds the bundles and fails if they differ from the committed ones.
