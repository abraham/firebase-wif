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
    expect(analysis).toEqual({ deployJobs: 0, findings: [], writesCredentialsToWorkspace: false, parseErrors: [] });
  });
});
