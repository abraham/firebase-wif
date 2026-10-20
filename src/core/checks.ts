import { MANAGED_MARKER } from './naming.js';
import { estimateSub, GOOGLE_SUBJECT_MAX_BYTES } from './oidc.js';
import { rolesOf } from './policy.js';
import {
  read,
  readProjectPolicy,
  readServiceAccount,
  readServiceAccountKeys,
  readServiceAccountPolicy,
  repoPrincipal,
  type Runtime,
} from './runtime.js';
import type { Check } from './types.js';
import { analyzeWorkflows } from './workflows.js';

/** A read-only check with no `setup` step. */
export interface Advisory {
  id: string;
  run(rt: Runtime): Promise<Omit<Check, 'id'>>;
}

const pass = (message: string) => ({ status: 'pass', message }) as const;
const warn = (message: string, fix?: string) => ({ status: 'warn', message, ...(fix ? { fix } : {}) }) as const;
const skipped = (message: string) => ({ status: 'skipped', message }) as const;

const IMPERSONATION_ROLES = ['roles/iam.workloadIdentityUser', 'roles/iam.serviceAccountTokenCreator'];
const LEGACY_SECRET = /^(FIREBASE_SERVICE_ACCOUNT.*|FIREBASE_TOKEN|GCP_SA_KEY)$/;

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

const project: Advisory = {
  id: 'gcp.project',
  async run(rt) {
    return pass(`${rt.ctx.projectId} accessible (#${rt.ctx.projectNumber})`);
  },
};

const operator: Advisory = {
  id: 'gcp.operator',
  async run(rt) {
    const missing = rt.preflight.missingPermissions;
    return missing.length
      ? warn(
          `you're missing ${missing.join(', ')}, so setup can't run`,
          'Ask a project owner to run firebase-wif setup.',
        )
      : pass('you can run setup');
  },
};

const serviceAccountKeys: Advisory = {
  id: 'gcp.sa-keys',
  async run(rt) {
    const account = await readServiceAccount(rt);
    if (account.kind !== 'found')
      return skipped(account.kind === 'missing' ? "service account doesn't exist yet" : account.reason);
    const keys = await readServiceAccountKeys(rt);
    if (keys.kind !== 'found') return skipped(keys.kind === 'missing' ? 'service account not found' : keys.reason);
    return keys.value.length
      ? warn(
          `${keys.value.length} user-managed key${keys.value.length === 1 ? '' : 's'} on ${rt.ctx.serviceAccount}`,
          'Delete the keys once deploys use WIF.',
        )
      : pass('no user-managed keys');
  },
};

const extraRoles: Advisory = {
  id: 'gcp.extra-roles',
  async run(rt) {
    const policy = await readProjectPolicy(rt);
    if (policy.kind !== 'found') return skipped(policy.kind === 'missing' ? 'project policy not found' : policy.reason);
    const extra = rolesOf(policy.value, `serviceAccount:${rt.ctx.serviceAccount}`).filter(
      (role) => !rt.ctx.roles.includes(role),
    );
    if (!extra.length) return pass('no roles beyond the requested ones');
    const account = await readServiceAccount(rt);
    const managed = account.kind === 'found' && account.value.description?.includes(MANAGED_MARKER);
    const note = rt.prune && !managed ? " (not pruned: firebase-wif doesn't manage this service account)" : '';
    return warn(
      `${rt.ctx.serviceAccount} also has ${extra.join(', ')}${note}`,
      managed ? 'firebase-wif setup --prune' : 'Remove the extra roles if deploys no longer need them.',
    );
  },
};

const broadImpersonation: Advisory = {
  id: 'gcp.wi-user-broad',
  async run(rt) {
    const account = await readServiceAccount(rt);
    if (account.kind !== 'found')
      return skipped(account.kind === 'missing' ? "service account doesn't exist yet" : account.reason);
    const policy = await readServiceAccountPolicy(rt, rt.ctx.serviceAccount);
    if (policy.kind !== 'found')
      return skipped(policy.kind === 'missing' ? 'service account not found' : policy.reason);
    const ours = repoPrincipal(rt.ctx);
    const broad = (policy.value.bindings ?? [])
      .filter((binding) => IMPERSONATION_ROLES.includes(binding.role))
      .flatMap((binding) => binding.members ?? [])
      .filter((member) => /^principal(Set)?:\/\//.test(member) && member !== ours);
    return broad.length
      ? warn(
          `other identities can act as ${rt.ctx.serviceAccount}: ${[...new Set(broad)].join(', ')}`,
          'Remove the grants unless they are intended.',
        )
      : pass('only this repository can act as the service account');
  },
};

const repo: Advisory = {
  id: 'gh.repo',
  async run(rt) {
    const message = `${rt.ctx.repo} (id ${rt.ctx.repoId})`;
    if (!rt.github) return pass(`${message}; GitHub checks skipped without credentials`);
    return rt.repo.permissions?.admin
      ? pass(message)
      : warn(
          `${message}; you aren't a repo admin, so setup can't change variables or environments`,
          'Ask a repo admin to run firebase-wif setup.',
        );
  },
};

const legacySecrets: Advisory = {
  id: 'gh.legacy-secrets',
  async run(rt) {
    const github = rt.github;
    if (!github) return skipped('no GitHub credentials');
    const secrets = await read(() =>
      github.request<{ secrets?: { name: string }[] }>('GET', `/repos/${rt.ctx.repo}/actions/secrets?per_page=100`),
    );
    if (secrets.kind !== 'found') return skipped(secrets.kind === 'missing' ? 'secrets not found' : secrets.reason);
    const legacy = (secrets.value.secrets ?? [])
      .map((secret) => secret.name)
      .filter((name) => LEGACY_SECRET.test(name));
    return legacy.length
      ? warn(`${legacy.join(', ')} still set`, 'Delete the secrets once deploys use WIF.')
      : pass('no service account key or token secrets');
  },
};

const oidcSub: Advisory = {
  id: 'gh.oidc-sub',
  async run(rt) {
    const github = rt.github;
    if (!github) return skipped('no GitHub credentials');
    const template = await read(() =>
      github.request<{ use_default?: boolean; include_claim_keys?: string[] }>(
        'GET',
        `/repos/${rt.ctx.repo}/actions/oidc/customization/sub`,
      ),
    );
    if (template.kind === 'skipped') return skipped(template.reason);
    const value = template.kind === 'found' ? template.value : { use_default: true };
    const useDefault = value.use_default !== false || !value.include_claim_keys?.length;
    const { environment } = rt.ctx;
    const estimate = estimateSub(
      { useDefault, includeClaimKeys: value.include_claim_keys ?? [] },
      {
        repo: rt.ctx.repo,
        repoId: rt.ctx.repoId,
        ownerId: rt.ctx.ownerId,
        branch: environment && environment.branch ? environment.branch : rt.ctx.defaultBranch,
        environment: environment ? environment.name : undefined,
      },
    );
    const kind = useDefault ? 'default sub template' : `customized sub (${value.include_claim_keys!.join(', ')})`;
    const summary = `${kind}; longest sub is about ${estimate.bytes} bytes`;
    return estimate.bytes > GOOGLE_SUBJECT_MAX_BYTES
      ? warn(
          `${summary}, over the ${GOOGLE_SUBJECT_MAX_BYTES}-byte google.subject limit`,
          'Use shorter branch/environment names or fewer sub claims.',
        )
      : pass(summary);
  },
};

const workflows: Advisory = {
  id: 'gh.workflows',
  async run(rt) {
    if (!rt.local?.workflows) return skipped('no local files provided');
    const analysis = analyzeWorkflows(rt.local.workflows);
    if (analysis.parseErrors.length) return warn(`couldn't parse ${analysis.parseErrors.join(', ')}`);
    if (!analysis.deployJobs) return skipped('no workflow deploys to Firebase yet');
    if (!analysis.findings.length) {
      return pass(`${analysis.deployJobs} deploy job${analysis.deployJobs === 1 ? '' : 's'} look right`);
    }
    return warn(
      analysis.findings.map((finding) => `${finding.file} ${finding.job}: ${finding.problems.join(', ')}`).join('; '),
      'See the workflow examples in the firebase-wif README.',
    );
  },
};

export const LOCAL_CHECKS: readonly Advisory[] = [firebaseJson, projectMatch, credsIgnored];
export const GCP_ADVISORIES: Readonly<Record<string, Advisory>> = {
  project,
  operator,
  serviceAccountKeys,
  extraRoles,
  broadImpersonation,
};
export const GITHUB_ADVISORIES: readonly Advisory[] = [repo, legacySecrets, oidcSub, workflows];
