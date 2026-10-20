# Multiple projects

Code: `src/core/engine/`, `src/core/discovery/context.ts`, `src/cli/main.ts`
Tests: `test/core/engine/engine.test.ts`, `test/core/engine/chain.test.ts`, `test/core/discovery/context.test.ts`, `test/cli/main.test.ts`

Firebase repositories often deploy to several projects, such as `staging` and `prod` aliases in `.firebaserc`. One trust chain can serve all of them, because IAM roles work across projects: the pool, provider, and service account live in one project, the home project, and the other projects only grant deploy roles to that service account.

## Home project

The first `setup` creates the pool, provider, and service account in its project and writes the repo variables. That project is the home project.

A later run against another project sees that the repo variables point at a provider in a different project and reuses that chain. A run is cross-project when all of these hold:

- The provider from the repo variables (or from `home`) is in a project with a different number.
- A service account is known, from the variables or `home`.
- No explicit `--pool`, `--provider`, or `--service-account` was passed.

Passing explicit names turns this off and builds an independent chain in the other project. A different `--variable-prefix`, such as `FIREBASE_WIF_STAGING_`, also gives each project its own chain and variables.

## What a cross-project run does

- **Names:** the pool and provider names point at the home project, and the service account is the home project's. `context.homeProjectId` is the service account's project.
- **Resources:** only the project-scoped resources are reconciled in this project: `gcp.apis`, `gcp.project-roles`, and, with the `functions` preset, `gcp.runtime-sa-user` for this project's runtime service accounts. The trust-chain resources (`gcp.pool`, `gcp.provider`, `gcp.provider-condition`, `gcp.service-account`, `gcp.wi-user`, `gh.variables`, `gh.environment`) are skipped with `shared from <home>; check it with --project <home>`, and `setup` never creates a second chain or changes the variables.
- **APIs:** the required APIs leave out `iamcredentials` and `sts`, which only the home project needs for token exchange.
- **Permissions:** the preflight asks only for `CROSS_PROJECT_PERMISSIONS` (see `context-and-credentials.md`).
- **Checks:** checks about the service account itself (`gcp.sa-keys`, `gcp.wi-user-broad`) still run against the home project's account; `gcp.extra-roles` and `--prune` apply to this project's policy.
- **Output:** the header names the home project.

## The `home` option

`home: { provider, serviceAccount }` names an existing trust chain directly, instead of reading the repo variables. When it's in another project, the run is cross-project as above. When it's in the same project, it just names the chain to check. It works without GitHub credentials, and turns off adoption. An invalid provider name or service account email fails with `INVALID_NAME`.

## `--all-aliases`

`status --all-aliases` and `setup --all-aliases` run once per project in `.firebaserc`: each project once, under its first alias, with `default` first. The first project's provider and service account are passed to the others as `home`, so:

- `setup --all-aliases --dry-run` plans the other projects correctly even before the variables exist.
- It works without GitHub credentials, when the variables can't be read.
- If the default project isn't the home project, the variables still decide: the first project's run follows them to the real home, and passes that on.

A project that can't be checked or set up stops the run, because later projects would have no chain to share. The CLI's output and exit codes for this are in `cli.md`.

## Security

- Never create a second chain or change the repo variables from another project.
- Grant other projects only their deploy roles, so the service account's identity and trust stay defined in one place.
- Ask only for the permissions a cross-project run uses.

## How it's tested

- `test/core/engine/engine.test.ts` checks a cross-project status and setup (only APIs and roles change; no second pool, provider, or service account; variables untouched; a second plan is empty), the `home` option with and without GitHub, explicit names starting an independent chain, an invalid `home`, and functions runtime grants in another project.
- `test/core/discovery/context.test.ts` checks alias listing order and deduplication.
- `test/cli/main.test.ts` checks `--all-aliases` in text and JSON, setting up the home project first, stopping on an error, and its usage errors.
