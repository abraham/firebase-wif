import { describe, expect, it } from 'vitest';
import * as testing from '../../src/testing/index.js';

describe('testing entry point', () => {
  it('exports the fakes', () => {
    expect(Object.keys(testing).sort()).toEqual(['createConfiguredFakes', 'createFakeGitHub', 'createFakeGoogle']);
  });
});
