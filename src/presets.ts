import type { PresetName } from './core/types.js';

export type { PresetName } from './core/types.js';

export interface Preset {
  roles: string[];
  apis: string[];
}

export const PRESET_NAMES: readonly PresetName[] = ['hosting', 'firestore', 'storage', 'functions'];

/** APIs the trust chain itself needs, whatever gets deployed. */
export const BASE_APIS: readonly string[] = [
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'cloudresourcemanager.googleapis.com',
];

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  hosting: {
    roles: ['roles/firebasehosting.admin'],
    apis: ['firebasehosting.googleapis.com'],
  },
  firestore: {
    roles: ['roles/firebaserules.admin', 'roles/datastore.indexAdmin', 'roles/serviceusage.serviceUsageConsumer'],
    apis: ['firestore.googleapis.com', 'firebaserules.googleapis.com'],
  },
  storage: {
    roles: [
      'roles/firebaserules.admin',
      'roles/firebasestorage.viewer',
      // The Storage rules deploy looks up the default bucket (firebase/firebase-tools#6593).
      'roles/storage.bucketViewer',
      'roles/serviceusage.serviceUsageConsumer',
    ],
    apis: ['firebasestorage.googleapis.com', 'firebaserules.googleapis.com'],
  },
  functions: {
    roles: ['roles/cloudfunctions.admin', 'roles/serviceusage.serviceUsageConsumer'],
    apis: [
      'cloudfunctions.googleapis.com',
      'cloudbuild.googleapis.com',
      'artifactregistry.googleapis.com',
      'run.googleapis.com',
      'eventarc.googleapis.com',
    ],
  },
};

export const SCHEDULER_ROLE = 'roles/cloudscheduler.admin';
export const SERVICE_ACCOUNT_USER_ROLE = 'roles/iam.serviceAccountUser';

/** Presets for the products configured in `firebase.json`, or `hosting` when there are none. */
export const resolvePresets = (firebaseJson?: Record<string, unknown>): PresetName[] => {
  const found = PRESET_NAMES.filter((name) => firebaseJson && name in firebaseJson);
  return found.length ? found : ['hosting'];
};

const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

export const rolesFor = ({
  presets,
  roles = [],
  scheduler = false,
}: {
  presets: PresetName[];
  roles?: string[];
  scheduler?: boolean;
}): string[] =>
  unique([
    ...presets.flatMap((name) => PRESETS[name].roles),
    ...(scheduler && presets.includes('functions') ? [SCHEDULER_ROLE] : []),
    ...roles,
  ]);

export const apisFor = (presets: PresetName[]): string[] =>
  unique([...BASE_APIS, ...presets.flatMap((name) => PRESETS[name].apis)]);
