import { read } from '../io/reads.js';
import { pass, skipped, warn, type Advisory } from './advisory.js';
import { estimateSub, GOOGLE_SUBJECT_MAX_BYTES } from './oidc.js';
import { analyzeWorkflows } from './workflows.js';

const LEGACY_SECRET = /^(FIREBASE_SERVICE_ACCOUNT.*|FIREBASE_TOKEN|GCP_SA_KEY)$/;

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

export const GITHUB_ADVISORIES = {
  repo,
  legacySecrets,
  oidcSub,
  workflows,
} as const satisfies Record<string, Advisory>;
