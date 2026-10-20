# CLI

Code: `src/cli/main.ts`, `src/cli/render.ts`, `src/cli/index.ts`
Tests: `test/cli/main.test.ts`, `test/cli/render.test.ts`, `test/cli/index.test.ts`, `test/structure.test.ts`

The `firebase-wif` command is a thin layer over the Node API. It discovers the project and repo, gets credentials, calls `status`, `plan`, or `setup`, and renders the result. Every decision about what to check or change lives in the engine, so the CLI only owns arguments, prompts, output, and exit codes. It imports only from the public entry points (see `node-api.md`), so a program can do anything it does.

It's installed as the `firebase-wif` bin (`dist/cli/index.js`) of `@abraham/firebase-wif`, and runs without installing as `npx @abraham/firebase-wif`.

## Commands

```
firebase-wif [status] [options]   read-only checks (the default command)
firebase-wif setup [options]      create or repair everything status checks
```

At most one command is allowed. Anything else, including extra positional arguments, prints `Unknown command` and the usage to stderr and exits 2. `-h`/`--help` prints the usage to stdout and `--version` prints the package version, both exiting 0 before any other validation, so `firebase-wif setup --bogus --help` still shows the help.

## Options

| Option                                           | Default                                       | Description                                                                     |
| ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `--project <id\|alias>`                          | `.firebaserc` default                         | Project ID, or an alias from `.firebaserc`                                      |
| `--all-aliases`                                  | off                                           | Run once per project in `.firebaserc` (see below)                               |
| `--repo <owner/name>`                            | git remote                                    | GitHub repository                                                               |
| `--pool <id>`                                    | `github`                                      | Workload identity pool ID                                                       |
| `--provider <id>`                                | `github-<repoId>`                             | Provider ID                                                                     |
| `--service-account <id\|email>`                  | `github-<repoId>`                             | Deploy service account ID or email                                              |
| `--preset <name>` (repeatable)                   | from `firebase.json`                          | `hosting`, `firestore`, `storage`, or `functions`                               |
| `--role <role>` (repeatable)                     |                                               | Extra project role on top of the presets                                        |
| `--runtime-service-account <email>` (repeatable) | the project's default compute service account | Functions runtime service accounts the deploy service account may act as        |
| `--environment <name>`                           | `production`                                  | GitHub environment to create or check                                           |
| `--no-environment`                               | off                                           | Skip the GitHub environment                                                     |
| `--branch <name>`                                | the repo's default branch                     | Branch allowed to deploy to the environment                                     |
| `--any-branch`                                   | off                                           | Let any branch deploy to the environment                                        |
| `--variable-prefix <prefix>`                     | `FIREBASE_WIF_`                               | Repo variables are `<prefix>PROVIDER` and `<prefix>SERVICE_ACCOUNT`             |
| `--json`                                         | off                                           | Print JSON instead of text (see JSON output)                                    |
| `--cwd <dir>`                                    | the current directory                         | Where to look for `firebase.json`, `.firebaserc`, workflows, and the git remote |
| `-h`, `--help`                                   |                                               | Print the usage                                                                 |
| `--version`                                      |                                               | Print the version                                                               |

`setup` only:

| Option        | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `--dry-run`   | Print the plan and exit without changing anything                            |
| `-y`, `--yes` | Apply without asking. Required when the CLI can't prompt.                    |
| `--adopt`     | Adopt a setup found through legacy repo variables without asking             |
| `--prune`     | Remove unrequested project roles from a service account firebase-wif manages |

Flags that the engine passes on (names, presets, roles, environment, prefix) are validated by the engine, so an invalid name exits 2 with the engine's message. The CLI itself rejects, with exit 2:

- An unknown flag or a missing flag value (the message from Node's argument parser, then the usage).
- A `setup`-only flag with `status`: `--dry-run only works with setup.`
- `--any-branch` with `--branch`, and `--all-aliases` with `--project`.
- An unknown `--preset`, listing the valid names.

How the project, repo, presets, and credentials are found is in `context-and-credentials.md` and `presets.md`.

## How a run works

1. Parse and validate the arguments.
2. With `--all-aliases`, list the projects in `.firebaserc`.
3. Get a Google client. Without Google credentials, print the error and its fix, and exit 3.
4. Get a GitHub client. Without GitHub credentials, print `No GitHub credentials; skipping GitHub checks. Run gh auth login to include them.` to stderr and continue: the repo is still looked up without credentials, and GitHub changes become manual steps.
5. For each project (one, or each alias), discover the context from `--cwd`, then run `status` or `setup` for it.

Discovery failures, such as no project in `.firebaserc`, a remote that isn't github.com, or invalid JSON, exit 2.

## `status`

Runs the engine's `status` and prints the report. The CLI always passes `adopt: true`, so for a repo set up by an older script, status checks the resources its legacy variables point at and reports what `setup --adopt` would change. `status` never prompts and never writes.

## `setup`

1. Without `--dry-run`, call the engine's `setup` with a `confirm` callback. With `--dry-run`, call `plan` instead. In a terminal, if the engine finds a legacy setup and `--adopt` wasn't passed, ask `Adopt <provider> and <service account> from <variable> and <variable>?` first. Without a terminal and without `--adopt`, legacy setups aren't adopted.
2. If the operator is missing permissions for Google Cloud changes, the engine throws `MISSING_PERMISSIONS` before `confirm` is called: print the error, which lists the permissions, and exit 3. Nothing has been written. `--dry-run` still prints the plan, so it shows what needs those permissions.
3. `confirm` prints the plan. If it's empty, print `Already set up.` and exit 0. With `--dry-run`, the plan is printed and the run exits 0.
4. If the plan has changes firebase-wif can make itself (not only manual steps) and `--yes` wasn't passed, ask `Apply these changes? [y/N]`. Declining prints `Cancelled; nothing changed.` and exits 1. When the CLI can't prompt (stdin or stdout isn't a terminal, or `--json`), it prints `Pass --yes to apply changes without a prompt.` and exits 2.
5. Apply. Each change prints `✓ <description>` as it finishes, and retries print `retrying in <n>s: <reason>`.
6. Print the final status report, then `Do by hand:` with any manual steps, then, if anything was applied, a note that IAM changes can take a few minutes and a link to the README workflow examples.

A plan with only manual steps (for example, repo variables without GitHub access) skips the prompt and goes straight to the final status.

Prompts accept `y` or `yes` in any case; anything else is no.

## Interrupting

Ctrl-C (SIGINT) aborts the run through the engine's `signal`: no new request starts and nothing more is written. The CLI prints `Interrupted.` to stderr and exits 130. During `setup`, the `✓` lines above it show what was already applied, and running `setup` again finishes the rest, because every step is safe to repeat. Ctrl-C at a prompt is the same as declining, but exits 130. A second Ctrl-C exits immediately.

## `--all-aliases`

Runs the command once per project in `.firebaserc`: each project once, under its first alias, with `default` first. The first project's provider and service account are passed to the others as the engine's `home` option, so they share one trust chain (see `multi-project.md`).

- Each project's output starts with its own header; text output separates projects with a blank line.
- The exit code is the worst one across projects.
- A project that couldn't be checked or set up (an error, a declined prompt, a missing `--yes`, or Ctrl-C) stops the run, because later projects have no trust chain to share.
- It fails with exit 2 when `.firebaserc` has no projects.

## Text output

Reports and plans go to stdout. Errors go to stderr as the message, then `  fix: <fix>` when there is one.

Every report and plan starts with a header that says where each value came from:

```
firebase-wif status
  project  demo-project (#123456789012, from .firebaserc default)
  repo     octo-org/site (id 987654321, from git remote origin)
  home     other-project (shares its provider and service account)
```

The `home` line only appears when another project holds the trust chain. A `setup` plan adds `adopt` lines when it's adopting a legacy setup.

Status checks are grouped under `Local`, `Google Cloud`, and `GitHub`, one per line, with a symbol (`✓` pass, `!` warn, `✗` fail, `-` skipped), the check ID, and its message. Checks that didn't pass add a `fix:` line. The report ends with a summary such as `1 failed, 2 warnings, 17 passed, 1 skipped`; the skipped count is left out when it's zero.

```
  Google Cloud
    ✓ gcp.project             demo-project accessible (#123456789012)
    ✗ gcp.project-roles       grant roles/firebasehosting.admin on demo-project to github-987654321@...
        fix: firebase-wif setup
```

A plan lists `Changes` and then `Do by hand`. Each change has a sign for its action: `+` for create, enable, undelete, and bind; `~` for set and update; `-` for unbind.

```
  Changes
    + create workload identity pool github
    ~ set repo variable FIREBASE_WIF_PROVIDER to projects/...

  Do by hand
    - set repo variable FIREBASE_WIF_SERVICE_ACCOUNT to github-987654321@...
```

## JSON output

With `--json`, results and errors go to stdout as one pretty-printed JSON document, and nothing prompts.

| Command                    | Output                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `status`                   | The `StatusReport`: `{ ok, context, checks, changes, preflight }`      |
| `setup --dry-run`          | `{ context, changes, preflight }` from the plan                        |
| `setup --yes`              | The `ApplyResult`: `{ applied, manual, status }`                       |
| `setup` with an empty plan | The `ApplyResult`, with nothing applied                                |
| A `FirebaseWifError`       | `{ error: { code, message, fix } }`, with the exit code from the table |

Usage errors the CLI finds itself (an unknown flag, conflicting flags, `setup` without `--yes`) are still printed as text to stderr, with exit code 2. So are the GitHub-credentials note and `Interrupted.`. The JSON output never includes the `cancelled` field of the engine's `SetupResult`.

With `--all-aliases`, the output is one array with an entry per project: the object above with an `alias` field added, for example `[{ "alias": "default", "ok": true, ... }]`.

The types are defined in `node-api.md`.

## Exit codes

| Code | Meaning                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `status`: no check failed (warnings are fine). `setup`: the final status passes, the plan was empty, or `--dry-run`. `--help` and `--version`.                                                             |
| 1    | `status`: a check failed. `setup`: the final status fails, the prompt was declined, or applying stopped (`APPLY_FAILED`, `PROVIDER_OWNED_BY_OTHER_REPO`, `ORG_POLICY_BLOCKS_ISSUER`, `OPERATION_TIMEOUT`). |
| 2    | Usage error: unknown command or flag, conflicting flags, unknown preset, `INVALID_NAME`, discovery failure, `--all-aliases` without aliases, or `setup` that needs `--yes`.                                |
| 3    | Can't run: no Google credentials, the project or repo can't be read (`PROJECT_NOT_FOUND`, `REPO_NOT_FOUND` from the API), or `MISSING_PERMISSIONS`.                                                        |
| 130  | Interrupted with Ctrl-C.                                                                                                                                                                                   |

Errors that aren't a `FirebaseWifError` are bugs. They aren't caught, so Node prints the stack trace and exits 1.

## Compatibility

Commands, flags, exit codes, and the JSON output shapes are public API: changing them is a breaking change. Check IDs and `Change.action` values in the output are public too. The text output and the `message` and `fix` strings are for people and may change in any release; scripts should use `--json` and exit codes.

## Security

- Never print token values, in text or JSON. Credentials come from the lookup in `context-and-credentials.md`, which runs `gcloud` and `gh` with `execFile`, never a shell.
- Never change anything without confirmation: `setup` asks first, or needs `--yes` when it can't ask. `--dry-run` and `status` never write.
- Never adopt a legacy setup without asking, unless `--adopt` is passed.
- Check permissions before asking or writing, so a run without enough access stops before its first change instead of partway through.
- Stop writing as soon as the run is interrupted.

## How it's tested

- `test/cli/main.test.ts` runs `main()` in-process with injected dependencies: the `/testing` fakes as the Google and GitHub clients, a temporary repo directory, a fake `git` remote, captured stdout and stderr, an injectable terminal check and prompt, and an injectable abort signal standing in for Ctrl-C. It covers the full status report as an inline snapshot, every exit code, JSON output, `--help` and `--version` ahead of other errors, the prompt and `--yes` paths, missing permissions before any prompt, adoption, missing GitHub credentials, interrupting during apply and at a prompt, `--all-aliases` in text and JSON, and that `--dry-run` and declined prompts write nothing.
- `test/cli/render.test.ts` checks the text rendering of reports and plans directly: grouping, symbols and signs, fix lines, summary counts, and the `home` and `adopt` header lines.
- `test/cli/index.test.ts` checks that the bin entry point passes `process.argv` to `main()`, ties SIGINT to its abort signal, and sets `process.exitCode` from its result.
- `test/structure.test.ts` checks that `src/cli/` imports only from the public entry points.
