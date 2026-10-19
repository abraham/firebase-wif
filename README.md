# firebase-wif

Deploy to Firebase from GitHub Actions with Workload Identity Federation (OIDC), without service account keys or `FIREBASE_TOKEN`.

- **CLI**: `npx @abraham/firebase-wif status` checks the Google Cloud project and GitHub repo; `setup` creates or repairs everything, and is safe to re-run.
- **GitHub Action**: `abraham/firebase-wif@v0` turns the job's OIDC token into Google credentials for `npx firebase-tools`, `FirebaseExtended/action-hosting-deploy`, and `w9jds/firebase-action`.
- **Node API**: the same engine as a library, for project CLIs that want their own UX.

## Quick start

In your repo, signed in with `gcloud auth login` (or Application Default Credentials) and `gh auth login`:

```sh
npx @abraham/firebase-wif setup
```

It reads the project from `.firebaserc` and the repo from the git remote, prints a plan, and asks before changing anything. It creates:

- A workload identity pool (`github`) and a provider (`github-<repoId>`) that only trusts this repository's numeric ID.
- A deploy service account (`github-<repoId>`) with the roles for what `firebase.json` deploys (Hosting only by default).
- The repo variables `FIREBASE_WIF_PROVIDER` and `FIREBASE_WIF_SERVICE_ACCOUNT`.
- A `production` environment that only the default branch can deploy to.

Check it any time with `npx @abraham/firebase-wif status`. Then add the Action to a workflow.

## Usage

The job needs `id-token: write`. Pull requests from forks can't get OIDC tokens, so guard those jobs with `if: github.event.pull_request.head.repo.full_name == github.repository`.

### `npx firebase-tools`

```yaml
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v7
      - run: npm ci && npm run build
      - uses: abraham/firebase-wif@v0
        with:
          workload_identity_provider: ${{ vars.FIREBASE_WIF_PROVIDER }}
          service_account: ${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}
      - run: npx firebase-tools deploy --only hosting --non-interactive
```

Preview channels work the same way:

```yaml
- id: deploy
  run: |
    npx firebase-tools hosting:channel:deploy "pr-${{ github.event.number }}" \
      --expires 7d --json > deploy.json
    echo "url=$(jq -r '.result[].url' deploy.json)" >> "$GITHUB_OUTPUT"
```

### `FirebaseExtended/action-hosting-deploy`

```yaml
- id: wif
  uses: abraham/firebase-wif@v0
  with:
    workload_identity_provider: ${{ vars.FIREBASE_WIF_PROVIDER }}
    service_account: ${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}
- uses: FirebaseExtended/action-hosting-deploy@v0
  with:
    repoToken: ${{ secrets.GITHUB_TOKEN }}
    firebaseServiceAccount: ${{ steps.wif.outputs.credentials_json }}
    projectId: ${{ steps.wif.outputs.project_id }}
```

### `w9jds/firebase-action`

It runs in a container, so pass the credentials JSON instead of a file path:

```yaml
- id: wif
  uses: abraham/firebase-wif@v0
  with:
    workload_identity_provider: ${{ vars.FIREBASE_WIF_PROVIDER }}
    service_account: ${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}
- uses: w9jds/firebase-action@v15
  with:
    args: deploy --only hosting
  env:
    GCP_SA_KEY: ${{ steps.wif.outputs.credentials_json }}
    PROJECT_ID: ${{ steps.wif.outputs.project_id }}
```

### Inputs

| Input                        | Required | Default                                 | Description                                                                                                                                                                       |
| ---------------------------- | -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workload_identity_provider` | yes      |                                         | Full provider resource name, usually `${{ vars.FIREBASE_WIF_PROVIDER }}`                                                                                                          |
| `service_account`            | yes      |                                         | Service account email, usually `${{ vars.FIREBASE_WIF_SERVICE_ACCOUNT }}`                                                                                                         |
| `project_id`                 | no       | `.firebaserc` default                   | Firebase project ID; falls back to the provider's project number                                                                                                                  |
| `working_directory`          | no       | `.`                                     | Where to look for `.firebaserc`                                                                                                                                                   |
| `audience`                   | no       | `https://iam.googleapis.com/<provider>` | For providers with custom `allowedAudiences`                                                                                                                                      |
| `verify`                     | no       | `true`                                  | Do a test token exchange so problems fail here, with a fix, instead of inside the deploy                                                                                          |
| `export_environment`         | no       | `true`                                  | Export `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, `GOOGLE_GHA_CREDS_PATH`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, and `CLOUDSDK_CORE_PROJECT` |

### Outputs

| Output                  | Description                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| `credentials_file_path` | Path to the `external_account` credentials file in `RUNNER_TEMP`                 |
| `credentials_json`      | The file's contents, masked, for actions that take a service account JSON string |
| `project_id`            | The resolved project ID                                                          |
| `service_account`       | The service account email                                                        |

The credentials file is written outside the workspace with mode `0600` and deleted when the job ends. It holds the job's OIDC request token, so never upload it as an artifact.

## CLI

```sh
npx @abraham/firebase-wif status [options]   # read-only checks (default)
npx @abraham/firebase-wif setup  [options]   # create or repair
```

Useful options (`--help` lists them all):

- `--project <id|alias>`, `--repo <owner/name>`: override what's found in `.firebaserc` and the git remote.
- `--preset hosting|firestore|storage|functions` (repeatable) and `--role <role>`: the deploy roles. By default the presets come from the keys in `firebase.json`.
- `--dry-run`, `--yes`: print the plan only, or apply without asking.
- `--prune`: remove roles that are no longer requested from a service account firebase-wif created.
- `--adopt`: reuse a setup made by `setup-wif.sh` or hoverboard (`GCP_WIF_PROVIDER`/`GCP_DEPLOY_SA` or `WIF_PROVIDER`/`DEPLOY_SERVICE_ACCOUNT` variables).
- `--all-aliases`: run for every project in `.firebaserc`. The first project holds the pool, provider, and service account; the others only get APIs and deploy roles.
- `--json`: machine-readable output.

Exit codes: `0` ok, `1` a check failed, `2` usage error, `3` missing credentials or permissions.

## Node API

```ts
import { setup, status } from '@abraham/firebase-wif';

const report = await status({ projectId: 'my-project', repo: 'me/site' });
if (!report.ok) console.log(report.changes.map((change) => change.description));

await setup({ projectId: 'my-project', repo: 'me/site', confirm: async (plan) => plan.changes.length < 10 });
```

The library never prints, prompts, or reads the environment or filesystem on its own. Other entry points:

- `@abraham/firebase-wif/credentials`: `createCredentialsConfig()` and `verifyCredentials()`, what the Action uses.
- `@abraham/firebase-wif/presets`: the role presets.
- `@abraham/firebase-wif/gh`: a GitHub client that goes through a signed-in `gh` CLI.
- `@abraham/firebase-wif/testing`: in-memory Google Cloud and GitHub fakes for testing integrations.

## Versioning

The npm package and the Action share a version. Every release gets a `v0.y.z` tag and moves the `v0.y` and `v0` tags. While on 0.x, a minor release may change the API, CLI flags, check IDs, or Action inputs; pin `@v0.y` or `@abraham/firebase-wif@~0.y` if you need stability.

## License

MIT
