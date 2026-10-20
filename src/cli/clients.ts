import {
  defaultGitHubClient,
  defaultGoogleClient,
  FirebaseWifError,
  type Exec,
  type GitHubClient,
  type GoogleClient,
} from '../index.js';
import { EXIT, type Output } from './output.js';

export type Connection =
  { kind: 'connected'; google: GoogleClient; github: GitHubClient | false } | { kind: 'failed'; code: number };

/** Gets the Google client, which is required, and the GitHub client, which is optional. */
export const connect = async (
  {
    env,
    exec,
    googleClient = () => defaultGoogleClient({ env, exec }),
    githubClient = () => defaultGitHubClient({ env, exec }),
  }: {
    env: NodeJS.ProcessEnv;
    exec?: Exec | undefined;
    googleClient?: (() => Promise<GoogleClient>) | undefined;
    githubClient?: (() => Promise<GitHubClient>) | undefined;
  },
  output: Output,
): Promise<Connection> => {
  let google: GoogleClient;
  try {
    google = await googleClient();
  } catch (error) {
    return { kind: 'failed', code: output.fail(error, EXIT.credentials) };
  }

  let github: GitHubClient | false;
  try {
    github = await githubClient();
  } catch (error) {
    if (!(error instanceof FirebaseWifError)) throw error;
    output.stderr('No GitHub credentials; skipping GitHub checks. Run gh auth login to include them.\n');
    github = false;
  }
  return { kind: 'connected', google, github };
};
