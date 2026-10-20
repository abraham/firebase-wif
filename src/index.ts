export { status, plan, setup } from './core/engine/engine.js';
export { CROSS_PROJECT_PERMISSIONS, SETUP_PERMISSIONS } from './core/engine/permissions.js';
export { resolveContext, parseGitHubRemote, projectAliases } from './core/discovery/context.js';
export type { ProjectAlias, ResolvedContext } from './core/discovery/context.js';
export {
  createGitHubClient,
  createGoogleClient,
  defaultGitHubClient,
  defaultGoogleClient,
} from './core/discovery/clients.js';
export type { Exec } from './core/discovery/exec.js';
export { DEFAULTS } from './core/naming.js';
export { FirebaseWifError, HttpError, isFirebaseWifError } from './core/errors.js';
export type { ErrorCode, ErrorDetails } from './core/errors.js';
export type {
  AdoptCandidate,
  ApplyResult,
  Change,
  ChangeAction,
  Check,
  CheckId,
  CheckStatus,
  Context,
  GitHubAuth,
  GitHubClient,
  GoogleAuth,
  GoogleClient,
  LocalFiles,
  Options,
  Plan,
  Preflight,
  PresetName,
  ProgressEvent,
  ResourceId,
  SetupOptions,
  SetupResult,
  StatusReport,
} from './core/types.js';
