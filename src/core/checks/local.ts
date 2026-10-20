import { pass, skipped, warn, type Advisory } from './advisory.js';
import { analyzeWorkflows } from './workflows.js';

const firebaseJson: Advisory = {
  id: 'local.firebase-json',
  async run(rt) {
    if (!rt.local) return skipped('no local files provided');
    return rt.local.firebaseJson ? pass('found') : warn('firebase.json not found', 'Run firebase init in this repo.');
  },
};

const projectMatch: Advisory = {
  id: 'local.project-match',
  async run(rt) {
    if (!rt.local) return skipped('no local files provided');
    const projects = rt.local.firebaserc?.projects ?? {};
    const fallback = projects.default;
    if (!fallback) return warn('.firebaserc has no default project', `firebase use --add ${rt.ctx.projectId}`);
    if (fallback === rt.ctx.projectId) return pass(`default is ${fallback}`);
    const alias = Object.keys(projects).find((name) => projects[name] === rt.ctx.projectId);
    return alias
      ? pass(`alias ${alias} is ${rt.ctx.projectId}`)
      : warn(`.firebaserc default is ${fallback}, not ${rt.ctx.projectId}`, `firebase use --add ${rt.ctx.projectId}`);
  },
};

const publicDirs = (firebaseJson: Record<string, unknown> | undefined) => {
  const hosting = firebaseJson?.hosting;
  const sites = Array.isArray(hosting) ? hosting : hosting ? [hosting] : [];
  return sites.map((site) => site as { public?: string; ignore?: string[] });
};

const credsIgnored: Advisory = {
  id: 'local.creds-ignored',
  async run(rt) {
    if (!rt.local) return skipped('no local files provided');
    const { writesCredentialsToWorkspace } = analyzeWorkflows(rt.local.workflows ?? {});
    if (!writesCredentialsToWorkspace) return pass('no workflow writes credential files into the workspace');

    const problems: string[] = [];
    if (!rt.local.gitignore?.includes('gha-creds-')) problems.push('.gitignore');
    const exposed = publicDirs(rt.local.firebaseJson).filter(
      (site) =>
        ['.', './', ''].includes(site.public ?? '') && !site.ignore?.some((glob) => glob.includes('gha-creds-')),
    );
    if (exposed.length) problems.push('the Hosting ignore list (public is the repo root)');
    return problems.length
      ? warn(
          `gha-creds-*.json from google-github-actions/auth isn't excluded from ${problems.join(' or ')}`,
          'Add gha-creds-*.json there, or switch to abraham/firebase-wif.',
        )
      : pass('gha-creds-*.json is excluded');
  },
};

/** In report order. */
export const LOCAL_CHECKS: readonly Advisory[] = [firebaseJson, projectMatch, credsIgnored];
