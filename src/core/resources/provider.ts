import { FirebaseWifError, WriteError } from '../errors.js';
import { IAM, providerId } from '../io/endpoints.js';
import { readPool, readProvider } from '../io/google-reads.js';
import type { Runtime } from '../io/reads.js';
import { waitForOperation, type Operation } from '../io/writes.js';
import {
  desiredAttributeCondition,
  desiredAttributeMapping,
  ISSUER,
  managedDescription,
  REQUIRED_MAPPING_KEYS,
} from '../naming.js';
import type { Change } from '../types.js';
import { change, drift, type Resource } from './resource.js';

const createProvider = async (rt: Runtime, id: string): Promise<Operation> => {
  const { pool, repo, repoId, ownerId } = rt.ctx;
  try {
    return await rt.google.request<Operation>('POST', `${IAM}/${pool}/providers?workloadIdentityPoolProviderId=${id}`, {
      displayName: `GitHub ${repo}`.slice(0, 32),
      description: managedDescription(repo, repoId),
      attributeMapping: desiredAttributeMapping(),
      attributeCondition: desiredAttributeCondition(repoId, ownerId),
      oidc: { issuerUri: ISSUER },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('constraints/iam.workloadIdentityPoolProviders')) {
      throw new WriteError(
        'ORG_POLICY_BLOCKS_ISSUER',
        "The organization policy constraints/iam.workloadIdentityPoolProviders doesn't allow GitHub Actions as an issuer.",
        `Ask an organization policy admin to add ${ISSUER} to the constraint's allowed values.`,
      );
    }
    throw error;
  }
};

export const provider: Resource = {
  id: 'gcp.provider',
  severity: 'fail',
  scope: 'trust-chain',
  async evaluate(rt) {
    const id = providerId(rt.ctx);
    const parent = await readPool(rt);
    if (parent.kind === 'skipped') return { kind: 'skipped', message: parent.reason };
    if (parent.kind === 'missing') return drift([change(this.id, 'create', `create provider ${id}`)]);

    const current = await readProvider(rt);
    if (current.kind === 'skipped') return { kind: 'skipped', message: current.reason };
    if (current.kind === 'missing') return drift([change(this.id, 'create', `create provider ${id}`)]);

    const value = current.value;
    if (value.state === 'DELETED') return drift([change(this.id, 'undelete', `restore deleted provider ${id}`)]);
    if (value.oidc?.issuerUri !== ISSUER) {
      const message = `Provider ${id} uses issuer ${value.oidc?.issuerUri ?? '(none)'}, not GitHub Actions.`;
      const fix = 'Pass --provider with a different provider ID.';
      return {
        kind: 'blocked',
        message,
        fix,
        error: new FirebaseWifError('PROVIDER_OWNED_BY_OTHER_REPO', message, { fix }),
      };
    }
    const changes: Change[] = [];
    if (value.disabled) changes.push(change(this.id, 'update', `re-enable provider ${id}`));
    const desired = desiredAttributeMapping();
    const missing = REQUIRED_MAPPING_KEYS.filter((key) => value.attributeMapping?.[key] !== desired[key]);
    if (missing.length) changes.push(change(this.id, 'update', `map ${missing.join(', ')} on provider ${id}`));
    return changes.length ? drift(changes) : { kind: 'ok', message: `${id} trusts ${ISSUER}` };
  },
  async apply(rt, w) {
    const id = providerId(rt.ctx);
    const current = await readProvider(rt);
    let operation: Operation;
    if (current.kind === 'missing') {
      operation = await createProvider(rt, id);
    } else if (current.kind === 'found' && current.value.state === 'DELETED') {
      operation = await rt.google.request<Operation>('POST', `${IAM}/${rt.ctx.provider}:undelete`, {});
    } else if (current.kind === 'found') {
      const mask: string[] = [];
      const body: Record<string, unknown> = {};
      if (current.value.disabled) {
        mask.push('disabled');
        body.disabled = false;
      }
      const desired = desiredAttributeMapping();
      const mapping = { ...current.value.attributeMapping };
      const missing = REQUIRED_MAPPING_KEYS.filter((key) => mapping[key] !== desired[key]);
      if (missing.length) {
        for (const key of missing) mapping[key] = desired[key]!;
        mask.push('attributeMapping');
        body.attributeMapping = mapping;
      }
      if (!mask.length) return;
      operation = await rt.google.request<Operation>(
        'PATCH',
        `${IAM}/${rt.ctx.provider}?updateMask=${mask.join(',')}`,
        body,
      );
    } else {
      return;
    }
    await waitForOperation(w, rt.google, IAM, operation, `set up provider ${id}`);
  },
};
