export { status, plan, SETUP_PERMISSIONS } from './core/engine.js';
export { resolveContext, parseGitHubRemote } from './core/context.js';
export type { ResolvedContext } from './core/context.js';
export {
  createGitHubClient,
  createGoogleClient,
  defaultGitHubClient,
  defaultGoogleClient,
} from './core/clients.js';
export { FirebaseWifError, HttpError } from './core/errors.js';
export type { ErrorCode } from './core/errors.js';
export type {
  AdoptCandidate,
  ApplyResult,
  Change,
  ChangeAction,
  Check,
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
  StatusReport,
} from './core/types.js';
