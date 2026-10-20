import { describe, expect, it } from 'vitest';
import { FirebaseWifError, HttpError, isFirebaseWifError, statusOf } from '../../src/core/errors.js';

describe('FirebaseWifError', () => {
  it('carries a code, fix, and details', () => {
    const error = new FirebaseWifError('MISSING_PERMISSIONS', 'Missing permissions.', {
      fix: 'Ask a project owner.',
      details: { missingPermissions: ['iam.serviceAccounts.create'] },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'FirebaseWifError',
      code: 'MISSING_PERMISSIONS',
      message: 'Missing permissions.',
      fix: 'Ask a project owner.',
      details: { missingPermissions: ['iam.serviceAccounts.create'] },
    });
  });

  it('leaves fix and details optional', () => {
    const error = new FirebaseWifError('INVALID_NAME', 'Bad name.');
    expect(error.fix).toBeUndefined();
    expect(error.details).toBeUndefined();
  });
});

describe('isFirebaseWifError', () => {
  it('matches by class and, when given, by code', () => {
    const error = new FirebaseWifError('INVALID_NAME', 'Bad name.');
    expect(isFirebaseWifError(error)).toBe(true);
    expect(isFirebaseWifError(error, 'INVALID_NAME')).toBe(true);
    expect(isFirebaseWifError(error, 'APPLY_FAILED')).toBe(false);
    expect(isFirebaseWifError(new Error('Bad name.'))).toBe(false);
    expect(isFirebaseWifError(undefined)).toBe(false);
  });
});

describe('HttpError', () => {
  it('carries the status', () => {
    const error = new HttpError(404, 'not found');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'HttpError', status: 404, message: 'not found' });
  });
});

describe('statusOf', () => {
  it('reads numeric statuses from any error-like value', () => {
    expect(statusOf(new HttpError(403, 'denied'))).toBe(403);
    expect(statusOf({ status: 409 })).toBe(409);
    expect(statusOf({ status: '404' })).toBeUndefined();
    expect(statusOf(new Error('plain'))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });
});
