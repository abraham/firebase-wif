import { FirebaseWifError } from '../errors.js';
import { IAM, providerId } from '../io/endpoints.js';
import { readProvider } from '../io/google-reads.js';
import { waitForOperation, type Operation } from '../io/writes.js';
import { desiredAttributeCondition } from '../naming.js';
import { analyzeCondition } from '../policy.js';
import { change, drift, type Resource } from './resource.js';

export const providerCondition: Resource = {
  id: 'gcp.provider-condition',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const id = providerId(rt.ctx);
    const current = await readProvider(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing' || current.value.state === 'DELETED') {
      return { kind: 'skipped', message: `provider ${id} doesn't exist yet` };
    }
    const { repo, repoId } = rt.ctx;
    const analysis = analyzeCondition(current.value.attributeCondition, repoId, repo);
    switch (analysis.kind) {
      case 'pinned':
        return { kind: 'ok', message: `only accepts ${repo} (id ${repoId})` };
      case 'other-repo': {
        const message = `Provider ${id} trusts another repository (${analysis.other}).`;
        const fix = "Pass --provider with a different provider ID; never re-point another repo's provider.";
        return {
          kind: 'blocked',
          message,
          fix,
          error: new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', message, { fix }),
        };
      }
      case 'missing':
        return drift([change(this.id, 'update', `limit provider ${id} to ${repo} (no attribute condition)`)]);
      case 'name-only':
        return drift([
          change(this.id, 'update', `pin provider ${id} to repository ID ${repoId} instead of the name ${repo}`),
        ]);
      case 'loose':
        return drift([
          change(this.id, 'update', `limit provider ${id} to ${repo} (condition doesn't pin a repository ID)`),
        ]);
    }
  },
  async apply(rt, w) {
    const operation = await rt.google.request<Operation>(
      'PATCH',
      `${IAM}/${rt.ctx.provider}?updateMask=attributeCondition`,
      {
        attributeCondition: desiredAttributeCondition(rt.ctx.repoId, rt.ctx.ownerId),
      },
    );
    await waitForOperation(w, rt.google, IAM, operation, `limit provider ${providerId(rt.ctx)} to ${rt.ctx.repo}`);
  },
};
