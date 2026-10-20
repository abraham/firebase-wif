import { describe, expect, it } from 'vitest';
import { change, drift, grant } from '../../../src/core/resources/resource.js';

describe('change', () => {
  it('only marks manual changes', () => {
    expect(change('gcp.pool', 'create', 'create pool')).toEqual({
      resource: 'gcp.pool',
      action: 'create',
      description: 'create pool',
    });
    expect(change('gh.variables', 'set', 'set it', true)).toMatchObject({ manual: true });
  });
});

describe('drift', () => {
  it('joins the change descriptions and keeps a fix only when given', () => {
    const changes = [change('gcp.pool', 'create', 'a'), change('gcp.pool', 'update', 'b')];
    expect(drift(changes)).toEqual({ kind: 'drift', message: 'a; b', changes });
    expect(drift(changes, 'do it')).toMatchObject({ fix: 'do it' });
  });
});

describe('grant', () => {
  it('adds the member, or returns nothing when it is already there', () => {
    const add = grant('roles/x', 'user:a');
    const next = add({ bindings: [] });
    expect(next).toEqual({ bindings: [{ role: 'roles/x', members: ['user:a'] }] });
    expect(add(next!)).toBeUndefined();
  });
});
