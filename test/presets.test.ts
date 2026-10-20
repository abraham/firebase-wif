import { describe, expect, it } from 'vitest';
import {
  apisFor,
  BASE_APIS,
  PRESET_NAMES,
  PRESETS,
  resolvePresets,
  rolesFor,
  SERVICE_ACCOUNT_USER_ROLE,
} from '../src/presets.js';

describe('PRESETS', () => {
  it('defines every preset with roles and APIs', () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...PRESET_NAMES].sort());
    for (const name of PRESET_NAMES) {
      expect(PRESETS[name].roles.length).toBeGreaterThan(0);
      expect(PRESETS[name].apis.every((api) => api.endsWith('.googleapis.com'))).toBe(true);
    }
  });

  it('never grants serviceAccountUser at the project level', () => {
    for (const name of PRESET_NAMES) expect(PRESETS[name].roles).not.toContain(SERVICE_ACCOUNT_USER_ROLE);
  });
});

describe('resolvePresets', () => {
  it('derives presets from firebase.json', () => {
    expect(resolvePresets(undefined)).toEqual(['hosting']);
    expect(resolvePresets({})).toEqual(['hosting']);
    expect(resolvePresets({ emulators: {} })).toEqual(['hosting']);
    expect(resolvePresets({ functions: {}, hosting: {}, emulators: {} })).toEqual(['hosting', 'functions']);
  });
});

describe('rolesFor', () => {
  it('keeps hosting to one role', () => {
    expect(rolesFor({ presets: ['hosting'] })).toEqual(['roles/firebasehosting.admin']);
  });

  it('deduplicates and sorts with extra roles', () => {
    const roles = rolesFor({
      presets: ['storage', 'firestore'],
      roles: ['roles/datastore.viewer', 'roles/firebaserules.admin'],
    });
    expect(roles.filter((role) => role === 'roles/firebaserules.admin')).toHaveLength(1);
    expect(roles).toContain('roles/datastore.viewer');
    expect(roles).toEqual([...roles].sort());
  });
});

describe('apisFor', () => {
  it('always includes the base APIs', () => {
    expect(apisFor(['hosting'])).toEqual([...BASE_APIS, 'firebasehosting.googleapis.com'].sort());
  });

  it('deduplicates shared APIs', () => {
    expect(apisFor(['firestore', 'storage']).filter((api) => api === 'firebaserules.googleapis.com')).toHaveLength(1);
  });
});
