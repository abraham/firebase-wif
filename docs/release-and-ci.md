# Release and CI

Code: `.github/workflows/ci.yml`, `.github/workflows/publish.yaml`, `.github/workflows/deploy.yml`, `.github/workflows/actions.lock`, `.github/dependabot.yml`, `package.json`, `.prettierrc.json`, `demo/`
Tests: `test/structure.test.ts`

The npm package and the Action ship from this repository under one version. Every change lands in `main` through a pull request that passes CI, and pushing a version tag publishes it.

## Versioning

The npm package `@abraham/firebase-wif` and the Action `abraham/firebase-wif` share one version, `0.y.z` until 1.0.

- Each release has one tag, `v0.y.z`. Tags are immutable, so there are no `v0.y` or `v0` tags that move to the latest release.
- While on 0.x, a minor release (`0.y`) may make breaking changes; patch releases never do. Breaking changes are listed in the release notes.
- Workflows pin the Action to a full version, `@v0.y.z`, and the README examples use the latest release. Dependabot keeps consumers' pins up to date. npm consumers who need stability use `@abraham/firebase-wif@~0.y`.

What counts as public API, where a change is breaking, is defined in each spec's Compatibility section: CLI commands, flags, exit codes, and JSON output (`cli.md`); exported functions, types, options, and error codes (`node-api.md`); Action inputs, outputs, and exported variables (`action.md`); check IDs and severities (`checks.md`); and preset names (`presets.md`).

## Publishing

Pushing a `v*` tag (`npm version <patch|minor|major>`, then `git push --follow-tags`) runs `.github/workflows/publish.yaml` in the `npm` environment, one publish at a time (`deploy-npm`):

1. Check that the tag is `v` plus the `package.json` version, and fail otherwise.
2. Build (through `prepack`) and publish under `latest` with npm trusted publishing on the newest Node LTS: the job's OIDC token authenticates to npm, so no npm token is stored, and the package gets provenance. The npm trusted publisher is configured for the workflow file `publish.yaml` and the environment `npm`.
3. The `npm` environment links to the published version on npmjs.com.

Quality checks aren't repeated: they're required to land in `main`. The npm package contains the built library and CLI (`dist/`, without `dist/action/`), the README, and the license.

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job             | Runs on             | Does                                                                                  |
| --------------- | ------------------- | ------------------------------------------------------------------------------------- |
| `lint`          | The newest Node LTS | Checks `.github/workflows/actions.lock` with `gh actions-lock --verify`, and Prettier |
| `test`          | Node 22, 24, and 26 | `npm ci`, typecheck, tests, the library build, and the consumer typecheck             |
| `action-bundle` | The newest Node LTS | Rebuilds `dist/action/` and fails if it differs from the committed bundle             |
| `ci-required`   |                     | Fails when any other job failed or was cancelled                                      |

`ci-required` and `deploy-required` (below) are the required checks for `main`, so the list of jobs can change without editing the ruleset. They run even when a job they need fails, because GitHub counts a skipped required check as passing. A new job in `ci.yml` goes in `ci-required`'s `needs` in the same change.

Conventions the checks enforce:

- Node 22 or later is supported (`engines.node`). The `test` matrix lists every supported LTS major, and its lowest entry matches `engines.node` and the `@types/node` major (Dependabot skips `@types/node` major updates). Jobs that need one version use `lts/*`; the Action bundle targets its `node24` runtime through esbuild's `--target`, whatever Node builds it.
- Workflows pin actions through `.github/workflows/actions.lock`: run `gh actions-lock` after changing any `uses:`.
- Prettier formats everything except `dist/action/` and `package-lock.json` (`.prettierignore`).
- `test/structure.test.ts` fails when a source file has no matching test file.
- A new esbuild version changes the bundle, so its update needs `npm run build:action` and the rebuilt bundle committed.

## Demo deploy

`.github/workflows/deploy.yml` checks the Action end to end against a real project, `fir-wif-demo`, using the `demo/` site:

- It runs on every same-repo pull request and on demand. Pull requests from forks are skipped, because they can't get OIDC tokens.
- It uses the Action at the commit being tested (`uses: ./`), not a released tag.
- Three jobs run in parallel, one per README example: `npx firebase-tools`, `FirebaseExtended/action-hosting-deploy`, and `w9jds/firebase-action`. Each deploys to its own preview channel, `demo-<run number>-<example>`, which expires after an hour, so runs never interfere and the live site is never touched.
- It runs in the `test` environment, which links to the run's preview channel and allows any branch, set up with `firebase-wif setup --environment test --any-branch`.
- Runs for the same pull request and example share a concurrency group, so a newer push cancels an older deploy.
- `deploy-required` passes only when every deploy succeeded. Deploys skipped for a fork pull request count as passing; any other skip, cancellation, or failure fails it.

## Dependency updates

Dependabot checks npm packages and GitHub Actions weekly. Third-party actions are pinned to a full version when they don't publish a moving major tag.

## Security

- Never store an npm token: publish only through trusted publishing, from the `npm` environment.
- Never publish a tag that doesn't match `package.json`.
- Ship only bundles that match their source: CI rebuilds and compares them.
- Give the demo deploy only `id-token: write` and `contents: read`, and never run it for fork pull requests.

## How it's tested

The workflows are the tests: CI on every pull request, the demo deploy on every same-repo pull request, and the publish workflow's tag check on every release. `test/structure.test.ts` keeps every source file paired with a test file.
