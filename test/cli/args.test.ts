import { describe, expect, it } from 'vitest';
import { parseCli, USAGE } from '../../src/cli/args.js';

const run = (argv: string[]) => {
  const result = parseCli(argv);
  if (result.kind !== 'run') throw new Error(`expected run, got ${result.kind}`);
  return result.args;
};

describe('parseCli', () => {
  it('defaults to status with the default variable prefix', () => {
    expect(run([])).toMatchObject({
      command: 'status',
      presets: [],
      variablePrefix: 'FIREBASE_WIF_',
      json: false,
      detailed: false,
      allAliases: false,
    });
  });

  it('maps flags to camelCase arguments', () => {
    expect(
      run([
        'setup',
        '--preset',
        'hosting',
        '--preset',
        'functions',
        '--role',
        'roles/x',
        '--service-account',
        'deployer',
        '--runtime-service-account',
        'r@p.iam.gserviceaccount.com',
        '--any-branch',
        '--no-environment',
        '--preview-environment',
        'pr',
        '--variable-prefix',
        'WIF_',
        '--dry-run',
        '-y',
        '--detailed',
      ]),
    ).toMatchObject({
      command: 'setup',
      presets: ['hosting', 'functions'],
      roles: ['roles/x'],
      serviceAccount: 'deployer',
      runtimeServiceAccounts: ['r@p.iam.gserviceaccount.com'],
      anyBranch: true,
      noEnvironment: true,
      previewEnvironment: 'pr',
      noPreviewEnvironment: false,
      variablePrefix: 'WIF_',
      dryRun: true,
      yes: true,
      detailed: true,
    });
  });

  it('puts --help and --version ahead of every other error', () => {
    expect(parseCli(['setup', '--bogus', '--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['deploy', '-h'])).toEqual({ kind: 'help' });
    expect(parseCli(['deploy', '--version'])).toEqual({ kind: 'version' });
  });

  it.each([
    [['--nope'], "Unknown option '--nope'"],
    [['deploy'], 'Unknown command: deploy\n\nUsage:'],
    [['status', 'setup'], 'Unknown command: status setup'],
    [['status', '--yes'], '--yes only works with setup.\n'],
    [['--any-branch', '--branch', 'main'], 'Pass either --branch or --any-branch, not both.\n'],
    [
      ['--preview-environment', 'pr', '--no-preview-environment'],
      'Pass either --preview-environment or --no-preview-environment, not both.\n',
    ],
    [['--all-aliases', '--project', 'p'], 'Pass either --project or --all-aliases, not both.\n'],
    [['--preset', 'database'], 'Unknown preset "database". Use one of: hosting, firestore, storage, functions.\n'],
  ])('rejects %j', (argv, message) => {
    const result = parseCli(argv);
    expect(result.kind).toBe('usage-error');
    expect(result.kind === 'usage-error' && result.message).toContain(message);
  });

  it('includes the usage only for parse errors and unknown commands', () => {
    const unknown = parseCli(['deploy']);
    const conflict = parseCli(['status', '--prune']);
    expect(unknown.kind === 'usage-error' && unknown.message.endsWith(USAGE)).toBe(true);
    expect(conflict.kind === 'usage-error' && conflict.message.includes('Usage:')).toBe(false);
  });
});
