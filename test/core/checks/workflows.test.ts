import { describe, expect, it } from 'vitest';
import { analyzeWorkflows } from '../../../src/core/checks/workflows.js';

describe('analyzeWorkflows', () => {
  it('flags deploy jobs that cannot mint OIDC tokens safely', () => {
    const analysis = analyzeWorkflows({
      '.github/workflows/preview.yml': `
on: pull_request
jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - run: npx firebase-tools hosting:channel:deploy pr-1
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
      '.github/workflows/deploy.yml': `
on:
  push:
    branches: [main]
permissions:
  id-token: write
jobs:
  deploy:
    steps:
      - uses: abraham/firebase-wif@v0
      - run: npx firebase deploy --only hosting
`,
      '.github/workflows/broken.yml': 'jobs: [',
    });
    expect(analysis.deployJobs).toBe(2);
    expect(analysis.parseErrors).toEqual(['.github/workflows/broken.yml']);
    expect(analysis.findings).toEqual([
      {
        file: '.github/workflows/preview.yml',
        job: 'preview',
        problems: [
          'missing `permissions: id-token: write`',
          'runs on pull_request without a same-repo guard, so fork PRs fail',
          'does not use abraham/firebase-wif or google-github-actions/auth',
        ],
      },
    ]);
  });

  it('accepts the abrah.am preview job', () => {
    const analysis = analyzeWorkflows({
      'preview.yml': `
on:
  pull_request:
jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      id-token: write
    steps:
      - uses: google-github-actions/auth@v3.0.0
      - run: npx firebase hosting:channel:deploy "pr-1" --expires 7d
`,
    });
    expect(analysis.findings).toEqual([]);
    expect(analysis.writesCredentialsToWorkspace).toBe(true);
  });

  it('recognizes the other deploy actions, write-all, fork guards, and trigger lists', () => {
    const analysis = analyzeWorkflows({
      'a.yml': `
on: [push, pull_request_target]
permissions: write-all
jobs:
  hosting:
    if: \${{ !github.event.pull_request.head.repo.fork }}
    steps:
      - uses: google-github-actions/auth@v3
        with:
          create_credentials_file: false
      - uses: FirebaseExtended/action-hosting-deploy@v0
  docker:
    if: github.event.pull_request.head.repo.fork == false
    steps:
      - uses: abraham/firebase-wif@v0
      - uses: w9jds/firebase-action@v15
`,
    });
    expect(analysis.deployJobs).toBe(2);
    expect(analysis.findings).toEqual([]);
    expect(analysis.writesCredentialsToWorkspace).toBe(false);
  });

  it('ignores files without jobs and steps that are not deploys', () => {
    const analysis = analyzeWorkflows({
      'empty.yml': '',
      'scalar.yml': 'hello',
      'no-steps.yml': 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n',
      'mention.yml': 'on: push\njobs:\n  lint:\n    steps:\n      - run: echo "firebase deployment docs"\n',
    });
    expect(analysis).toEqual({
      deployJobs: 0,
      previewJobs: 0,
      previewEnvironments: [],
      findings: [],
      writesCredentialsToWorkspace: false,
      parseErrors: [],
    });
  });

  describe('environments', () => {
    const job = (environment: string, step: string) =>
      `on: push\npermissions: write-all\njobs:\n  d:\n${environment}    steps:\n      - uses: abraham/firebase-wif@v0\n${step}`;
    const run = (command: string) => `      - run: ${command}\n`;
    const hosting = (channelId?: string) =>
      `      - uses: FirebaseExtended/action-hosting-deploy@v0\n${channelId ? `        with:\n          channelId: ${channelId}\n` : ''}`;
    const firebaseAction = (args: string) =>
      `      - uses: w9jds/firebase-action@v15\n        with:\n          args: ${args}\n`;
    const expected = { live: { name: 'production', branch: 'main' }, preview: 'preview' };
    const problems = (text: string) => analyzeWorkflows({ 'd.yml': text }, expected).findings[0]?.problems ?? [];

    it('tells live deploys from preview channel deploys', () => {
      const live = 'deploys live without `environment: production`';
      const preview = 'deploys to a preview channel without `environment: preview`';
      expect(problems(job('', run('npx firebase-tools deploy --only hosting')))).toEqual([live]);
      expect(problems(job('', run('firebase hosting:channel:deploy pr-1')))).toEqual([preview]);
      expect(problems(job('', hosting('live')))).toEqual([live]);
      expect(problems(job('', hosting()))).toEqual([preview]);
      expect(problems(job('', hosting().replace('FirebaseExtended', 'firebaseextended')))).toEqual([preview]);
      expect(problems(job('', hosting('pr-${{ github.event.number }}')))).toEqual([preview]);
      expect(problems(job('', hosting("${{ github.event_name == 'push' && 'live' || '' }}")))).toEqual([]);
      expect(problems(job('', firebaseAction('deploy --only hosting')))).toEqual([live]);
      expect(problems(job('', firebaseAction('hosting:channel:deploy pr-1')))).toEqual([preview]);
      expect(problems(job('', firebaseAction('firestore:indexes')))).toEqual([]);
      expect(problems(job('', run('firebase hosting:channel:deploy pr-1') + run('firebase deploy')))).toEqual([live]);
    });

    it('checks the environment each job uses', () => {
      expect(problems(job('    environment: production\n', run('firebase deploy')))).toEqual([]);
      expect(problems(job('    environment:\n      name: production\n', run('firebase deploy')))).toEqual([]);
      expect(problems(job('    environment: preview\n', run('firebase deploy')))).toEqual([
        'deploys live in `preview`; use `environment: production`',
      ]);
      expect(problems(job('    environment: preview\n', hosting()))).toEqual([]);
      expect(problems(job('    environment: staging\n', hosting()))).toEqual([
        'deploys to a preview channel in `staging`; use `environment: preview`',
      ]);
      expect(problems(job('    environment: production\n', hosting()))).toEqual([
        'deploys to a preview channel in `production`, which only main can deploy to; use `environment: preview`',
      ]);
      expect(problems(job('    environment: ${{ inputs.env }}\n', run('firebase deploy')))).toEqual([]);
      expect(analyzeWorkflows({ 'd.yml': job('', run('firebase deploy')) }).findings).toEqual([]);
    });

    it('lists the environments preview jobs use', () => {
      const analysis = analyzeWorkflows({
        'a.yml': job('    environment: pr\n', hosting()),
        'b.yml': job('    environment: ${{ inputs.env }}\n', hosting()),
        'c.yml': job('', hosting()),
        'd.yml': job('    environment: pr\n', hosting()),
        'e.yml': job('    environment: production\n', run('firebase deploy')),
      });
      expect(analysis).toMatchObject({ deployJobs: 5, previewJobs: 4, previewEnvironments: ['pr'] });
    });
  });
});
