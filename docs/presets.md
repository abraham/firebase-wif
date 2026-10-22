# Presets

Code: `src/presets.ts`, `src/core/engine/chain.ts`
Tests: `test/presets.test.ts`, `test/core/engine/engine.test.ts`

A preset is the set of project roles and APIs the deploy service account needs to deploy one Firebase product. Presets keep a Hosting-only repository at a single role and add only what each product's deploy needs.

## Presets

| Preset      | `firebase.json` key | Project roles                                                                                                                                    | APIs                                                                  |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `hosting`   | `hosting`           | `roles/firebasehosting.admin`                                                                                                                    | `firebasehosting`                                                     |
| `firestore` | `firestore`         | `roles/firebaserules.admin`, `roles/datastore.indexAdmin`, `roles/serviceusage.serviceUsageConsumer`                                             | `firestore`, `firebaserules`                                          |
| `storage`   | `storage`           | `roles/firebaserules.admin`, `roles/firebasestorage.viewer`, `roles/storage.bucketViewer`, `roles/serviceusage.serviceUsageConsumer`             | `firebasestorage`, `firebaserules`                                    |
| `functions` | `functions`         | `roles/cloudfunctions.admin`, `roles/serviceusage.serviceUsageConsumer`, plus `roles/iam.serviceAccountUser` on runtime service accounts (below) | `cloudfunctions`, `cloudbuild`, `artifactregistry`, `run`, `eventarc` |

Every API name ends in `.googleapis.com`. The trust chain itself always needs `iam`, `iamcredentials`, `sts`, and `cloudresourcemanager` (`BASE_APIS`), whatever is deployed.

Why some roles are there:

- `hosting` is only `roles/firebasehosting.admin`, which covers both live and preview channel deploys.
- `roles/serviceusage.serviceUsageConsumer` is in every other preset because `firebase-tools` checks enabled APIs when it deploys those products.
- `storage` includes `roles/storage.bucketViewer` because the Storage rules deploy looks up the default bucket (firebase/firebase-tools#6593).

## Choosing presets

With `presets: 'auto'`, the default, presets come from the top-level keys of `firebase.json`: each preset whose key is present, in the order of the table. With no `firebase.json`, or none of those keys, the preset is `hosting`. Passing presets explicitly replaces this.

Any other role goes through `roles` (`--role`), on top of the presets. For example, scheduled functions also need `--role roles/cloudscheduler.admin`, and products without a preset (Realtime Database, Remote Config, Extensions, App Hosting) are covered by their roles.

`rolesFor({ presets, roles })` returns the presets' roles plus the extra roles, deduplicated and sorted. `apisFor(presets)` returns `BASE_APIS` plus the presets' APIs, deduplicated and sorted. Both accept readonly arrays. `isPresetName(name)` is a type guard for validating user input.

## Functions runtime service accounts

Deploying functions needs `roles/iam.serviceAccountUser` so the deploy can act as the functions' runtime service account. firebase-wif grants it on each runtime service account, never at the project level, where it would let the deploy act as every service account in the project. The runtime service accounts default to the project's default compute service account, `<projectNumber>-compute@developer.gserviceaccount.com`, and its App Engine default service account, `<projectId>@appspot.gserviceaccount.com`, which `firebase-tools` checks before every functions deploy when it exists. They can be set with `runtimeServiceAccounts` (`--runtime-service-account`). A runtime service account that doesn't exist yet is ignored until it does.

## Narrowing roles

Roles that are no longer requested, including roles an older setup granted, are reported by the `gcp.extra-roles` check (see `checks.md`). `--prune` removes them from a service account firebase-wif manages (see `reconcile.md`).

## Compatibility

Preset names are public API. Changing a preset's roles or APIs isn't a breaking change when it follows what `firebase-tools` needs to deploy that product, because existing setups pick it up through `status` and `setup`; it's noted in the release notes.

## Security

- Grant the fewest roles that let each product deploy, and add products' roles only when they're configured or requested.
- Never put `roles/iam.serviceAccountUser` in a preset; grant it only on runtime service accounts.

## How it's tested

- `test/presets.test.ts` checks every preset has roles and well-formed API names, that no preset grants `roles/iam.serviceAccountUser`, preset resolution from `firebase.json`, that Hosting stays at one role, and deduplication and sorting.
- `test/core/engine/engine.test.ts` checks the resolved roles and APIs in a run, and the runtime service account grant for the `functions` preset.
