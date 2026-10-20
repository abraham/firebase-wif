# Release and CI

Code: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `.github/workflows/deploy.yml`, `.github/dependabot.yml`, `package.json`, `.nvmrc`, `.prettierrc.json`, `demo/`
Tests: `test/structure.test.ts`

The npm package and the Action ship from this repository under one version. Every change lands in `main` through a pull request that passes CI, and a GitHub release publishes it.

## Versioning

The npm package `@abraham/firebase-wif` and the Action `abraham/firebase-wif` share one version, `0.y.z` until 1.0.

- Each release has one tag, `v0.y.z`. Tags are immutable, so there are no `v0.y` or `v0` tags that move to the latest release.
- While on 0.x, a minor release (`0.y`) may make breaking changes; patch releases never do. Breaking changes are listed in the release notes.
- Workflows pin the Action to a full version, `@v0.y.z`, and the README examples use the latest release. Dependabot keeps consumers' pins up to date. npm consumers who need stability use `@abraham/firebase-wif@~0.y`.

What counts as public API, where a change is breaking, is defined in each spec's Compatibility section: CLI commands, flags, exit codes, and JSON output (`cli.md`); exported functions, types, options, and error codes (`node-api.md`); Action inputs, outputs, and exported variables (`action.md`); check IDs and severities (`checks.md`); and preset names (`presets.md`).

## Publishing

Publishing a GitHub release runs `.github/workflows/publish.yml` in the `npm` environment:

1. Check that the release tag is `v` plus the `package.json` version, and fail otherwise.
2. Build (through `prepack`) and publish with npm trusted publishing: the job's OIDC token authenticates to npm, so no npm token is stored, and the package gets provenance.
3. A prerelease publishes under the `next` dist-tag; anything else under `latest`.

Quality checks aren't repeated: they're required to land in `main`. The npm package contains the built library and CLI (`dist/`, without `dist/action/`), the README, and the license.

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job             | Runs on                      | Does                                                                                    |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `test`          | Node 22, 24, and 26          | `npm ci`, the Prettier check, typecheck, tests, and the library build                   |
| `action-bundle` | The Node version in `.nvmrc` | Rebuilds `dist/action/` and fails if it differs from the committed bundle               |
| `success`       |                              | Passes only when every other job succeeded, including when one was cancelled or skipped |

`success` is the only required check for `main`, so the list of jobs can change without editing branch protection. It always runs, because GitHub counts a skipped required check as passing.

Conventions the checks enforce:

- Node 22 or later is supported (`engines.node`). Jobs that need one version read it from `.nvmrc`, which matches the Action's `node24` runtime.
- Prettier formats everything except `dist/action/` and `package-lock.json` (`.prettierignore`).
- `test/structure.test.ts` fails when a source file has no matching test file.
- A new esbuild version changes the bundle, so its update needs `npm run build:action` and the rebuilt bundle committed.

## Demo deploy

`.github/workflows/deploy.yml` checks the Action end to end against a real project, `fir-wif-demo`, using the `demo/` site:

- It runs on every same-repo pull request and on demand. Pull requests from forks are skipped, because they can't get OIDC tokens.
- It uses the Action at the commit being tested (`uses: ./`), not a released tag.
- Three jobs run in parallel, one per README example: `npx firebase-tools`, `FirebaseExtended/action-hosting-deploy`, and `w9jds/firebase-action`. Each deploys to its own preview channel, `demo-<run number>-<example>`, which expires after an hour, so runs never interfere and the live site is never touched.
- It runs in the `test` environment, which allows any branch, set up with `firebase-wif setup --environment test --any-branch`.

## Dependency updates

Dependabot checks npm packages and GitHub Actions weekly. Third-party actions are pinned to a full version when they don't publish a moving major tag.

## Security

- Never store an npm token: publish only through trusted publishing, from the `npm` environment.
- Never publish a tag that doesn't match `package.json`.
- Ship only bundles that match their source: CI rebuilds and compares them.
- Give the demo deploy only `id-token: write` and `contents: read`, and never run it for fork pull requests.

## How it's tested

The workflows are the tests: CI on every pull request, the demo deploy on every same-repo pull request, and the publish workflow's tag check on every release. `test/structure.test.ts` keeps every source file paired with a test file.
