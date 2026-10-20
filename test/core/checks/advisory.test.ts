import { describe, expect, it } from 'vitest';
import { pass, skipped, warn } from '../../../src/core/checks/advisory.js';

describe('advisory results', () => {
  it('builds pass, warn, and skipped results', () => {
    expect(pass('ok')).toEqual({ status: 'pass', message: 'ok' });
    expect(warn('careful')).toEqual({ status: 'warn', message: 'careful' });
    expect(warn('careful', 'do this')).toEqual({ status: 'warn', message: 'careful', fix: 'do this' });
    expect(skipped('later')).toEqual({ status: 'skipped', message: 'later' });
  });
});
