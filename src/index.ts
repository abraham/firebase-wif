export { status, plan, setup, CROSS_PROJECT_PERMISSIONS, SETUP_PERMISSIONS } from './core/engine.js';
export { resolveContext, parseGitHubRemote, projectAliases } from './core/context.js';
export type { ProjectAlias, ResolvedContext } from './core/context.js';
export { createGitHubClient, createGoogleClient, defaultGitHubClient, defaultGoogleClient } from './core/clients.js';
export type { Exec } from './core/clients.js';
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
