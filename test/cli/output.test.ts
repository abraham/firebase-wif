import { describe, expect, it } from 'vitest';
import { createOutput, EXIT, exitFor } from '../../src/cli/output.js';
import { FirebaseWifError } from '../../src/index.js';

const capture = (options: { json?: boolean; all?: boolean; signal?: AbortSignal } = {}) => {
  let stdout = '';
  let stderr = '';
  const output = createOutput({
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    json: options.json ?? false,
    all: options.all ?? false,
    signal: options.signal,
  });
  return { output, stdout: () => stdout, stderr: () => stderr };
};

const missing = new FirebaseWifError('PROJECT_NOT_FOUND', 'No project.', { fix: 'Pass --project.' });

describe('exitFor', () => {
  it('maps error codes to exit codes', () => {
    expect(exitFor(new FirebaseWifError('INVALID_NAME', 'x'))).toBe(EXIT.usage);
    expect(exitFor(missing)).toBe(EXIT.credentials);
    expect(exitFor(new FirebaseWifError('VERIFY_FAILED', 'x', { details: { stage: 'sts', status: 400 } }))).toBe(
      EXIT.failed,
    );
    expect(exitFor(new Error('bug'))).toBe(EXIT.failed);
  });
});

describe('createOutput', () => {
  it('prints errors as text with their fix', () => {
    const { output, stderr } = capture();
    expect(output.fail(missing, 3)).toBe(3);
    expect(stderr()).toBe('No project.\n  fix: Pass --project.\n');
  });

  it('prints errors as JSON with --json', () => {
    const { output, stdout } = capture({ json: true });
    output.fail(missing, 3);
    expect(JSON.parse(stdout())).toEqual({
      error: { code: 'PROJECT_NOT_FOUND', message: 'No project.', fix: 'Pass --project.' },
    });
  });

  it('collects JSON per alias with --all-aliases and prints one array on flush', () => {
    const { output, stdout } = capture({ json: true, all: true });
    output.setAlias('default');
    output.emit({ ok: true });
    output.setAlias('staging');
    output.fail(missing, 3);
    expect(stdout()).toBe('');
    output.flush();
    expect(JSON.parse(stdout())).toEqual([
      { alias: 'default', ok: true },
      { alias: 'staging', error: { code: 'PROJECT_NOT_FOUND', message: 'No project.', fix: 'Pass --project.' } },
    ]);
  });

  it('reports interruption instead of the error once aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const { output, stderr } = capture({ json: true, signal: controller.signal });
    expect(output.fail(new DOMException('stop', 'AbortError'), 1)).toBe(EXIT.interrupted);
    expect(stderr()).toBe('Interrupted.\n');
  });

  it('rethrows errors that are bugs', () => {
    const { output } = capture();
    expect(() => output.fail(new TypeError('bug'), 1)).toThrow('bug');
  });
});
