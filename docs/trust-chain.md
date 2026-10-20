# Trust chain

Code: `src/core/naming.ts`, `src/core/policy.ts`, `src/core/resources.ts`
Tests: `test/core/naming.test.ts`, `test/core/policy.test.ts`, `test/core/resources.test.ts`

The trust chain is everything that has to exist for a GitHub Actions job in one repository to act as a Google Cloud service account: the APIs, a workload identity pool and provider, a service account with deploy roles, a binding that lets the repository act as it, and the repo variables and environment on the GitHub side. This spec defines what each piece looks like when it's correct. How `setup` gets there is in `reconcile.md`.

## What has to exist

| Side   | Resource                     | Correct when                                                                                                                       |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Google | APIs                         | `iam`, `iamcredentials`, `sts`, `cloudresourcemanager`, and each preset's APIs (see `presets.md`) are enabled                      |
| Google | Workload identity pool       | Exists in `global`, is `ACTIVE`, and isn't disabled                                                                                |
| Google | OIDC provider in the pool    | Exists, is `ACTIVE`, isn't disabled, trusts GitHub's issuer, maps the required attributes, and has a condition pinned to this repo |
| Google | Deploy service account       | Exists and isn't disabled                                                                                                          |
| Google | Project roles                | The service account holds each requested role in an unconditional binding                                                          |
| Google | Workload identity user       | The service account's policy grants `roles/iam.workloadIdentityUser` to this repository's principal set                            |
| Google | Runtime service account user | With the `functions` preset, the deploy service account holds `roles/iam.serviceAccountUser` on each runtime service account       |
| GitHub | Repo variables               | `<prefix>PROVIDER` and `<prefix>SERVICE_ACCOUNT` hold the provider resource name and the service account email                     |
| GitHub | Environment                  | Exists, and only the deploy branch can deploy to it (or any branch, when configured)                                               |

## Default names

| Resource        | Default                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| Pool            | `github`, shared by every repository in the project                       |
| Provider        | `github-<repoId>`, one per repository                                     |
| Service account | `github-<repoId>@<projectId>.iam.gserviceaccount.com`, one per repository |
| Repo variables  | `FIREBASE_WIF_PROVIDER`, `FIREBASE_WIF_SERVICE_ACCOUNT`                   |
| Environment     | `production`, limited to the repository's default branch                  |

Names use the numeric repository ID so they survive renames, fit Google's length limits, and let several repositories share a project without colliding.

Names come from the first of these that applies:

1. Explicit names (`--pool`, `--provider`, `--service-account`).
2. The provider and service account the repo variables point at, when they're in the same project.
3. An adopted legacy setup (see `reconcile.md`).
4. The defaults above.

A provider and service account in another project make it a cross-project run instead (see `multi-project.md`).

## Provider configuration

A provider firebase-wif creates looks like this:

```
issuerUri:          https://token.actions.githubusercontent.com
attributeMapping:
  google.subject:                 assertion.sub
  attribute.repository:           assertion.repository
  attribute.repository_id:        assertion.repository_id
  attribute.repository_owner_id:  assertion.repository_owner_id
  attribute.ref:                  assertion.ref
  attribute.environment:          assertion.environment
attributeCondition: >-
  assertion.repository_id == '<repoId>' &&
  assertion.repository_owner_id == '<ownerId>'
displayName:        GitHub <owner>/<repo>   (truncated to 32 characters)
description:        Managed by firebase-wif for <owner>/<repo> (<repoId>)
```

An existing provider is correct when:

- Its issuer is GitHub's. A provider for any other issuer belongs to something else; firebase-wif refuses to touch it and suggests `--provider`.
- It maps `google.subject` and `attribute.repository_id` as above. Other mappings may differ; when these two are wrong, only they're changed, and the rest are kept.
- Its attribute condition pins this repository's ID.

### Attribute condition

The condition decides which tokens the provider accepts. It's classified against this repository:

| Condition                                                         | Classified as | Result                                                        |
| ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| Contains `assertion.repository_id == '<this repo's ID>'`          | pinned        | Correct. The owner-ID pin isn't required.                     |
| Pins another repository's ID or name                              | other repo    | Refused: firebase-wif never re-points another repo's provider |
| Only `assertion.repository == '<owner/name>'` for this repository | name only     | Tightened to the ID condition                                 |
| Missing or empty                                                  | missing       | The ID condition is added                                     |
| Contains `\|\|`, or pins no repository                            | loose         | Tightened to the ID condition                                 |

The owner-ID pin is added whenever firebase-wif writes the condition, but an existing condition that pins only the repository ID is accepted as is.

## Service account

A service account firebase-wif creates has the display name `GitHub Actions: <owner>/<repo>` and the description `Managed by firebase-wif for <owner>/<repo> (<repoId>)`. The `Managed by firebase-wif` marker is how `--prune` knows it may remove roles from the account; firebase-wif never prunes an account without it.

Only unconditional role bindings count: a role granted under an IAM condition may not apply when a deploy runs, so it doesn't satisfy a requested role and is never changed.

## Principal set

The repository is identified to IAM by its principal set in the pool:

```
principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/attribute.repository_id/<repoId>
```

`roles/iam.workloadIdentityUser` on the service account is granted to exactly this member.

## Validation

Every name is validated before it's used in any request, and an invalid one fails with `INVALID_NAME`:

| Name                  | Rule                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Project ID            | 6–30 lowercase letters, digits, or hyphens, starting with a letter and not ending with a hyphen |
| Repository            | `owner/name`                                                                                    |
| Pool and provider IDs | 4–32 lowercase letters, digits, or hyphens, not starting with `gcp-`                            |
| Service account ID    | Same as a project ID                                                                            |
| Service account email | Ends in `.gserviceaccount.com`                                                                  |
| Role                  | `roles/<name>`, `projects/<id>/roles/<name>`, or `organizations/<number>/roles/<name>`          |
| Repo variable         | Letters, digits, and underscores, not starting with `GITHUB_`                                   |

## Security

- Trust is pinned to the numeric repository ID, and the owner ID when firebase-wif writes the condition, never only to `owner/name` strings, so a deleted and recreated repository with the same name can't match.
- Never re-point a provider that trusts another repository or another issuer.
- Never grant `roles/iam.workloadIdentityUser` to a whole pool or to another repository's principal set.
- Never grant `roles/iam.serviceAccountUser` at the project level; grant it only on the runtime service accounts that need it.
- Only touch unconditional bindings, and only for the deploy service account.

## How it's tested

- `test/core/naming.test.ts` covers every validation rule, the default names, resource name parsing, and the principal set.
- `test/core/policy.test.ts` covers the condition classification table, and adding and removing members without touching conditional bindings or other members.
- `test/core/resources.test.ts` evaluates each resource against the `/testing` fakes in its correct and broken states.
