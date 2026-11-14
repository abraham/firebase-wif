import { describe, expect, it } from 'vitest';
import { deployDirectories } from '../../src/core/workflow-steps.js';

describe('deployDirectories', () => {
  it('lists the directories deploy steps run in, from the step, job, or workflow', () => {
    const directories = deployDirectories({
      'app.yml': `
on: push
jobs:
  app:
    steps:
      - run: npx firebase deploy --only hosting
      - uses: FirebaseExtended/action-hosting-deploy@v0
        with:
          entryPoint: ./web/
  server:
    defaults:
      run:
        working-directory: packages/server
    steps:
      - run: npm ci
        working-directory: packages/other
      - run: npx firebase deploy
`,
      'workflow-defaults.yml': `
on: push
defaults:
  run:
    working-directory: ./packages/api
jobs:
  deploy:
    steps:
      - run: npx firebase deploy
      - run: npx firebase deploy
        working-directory: \${{ matrix.dir }}
  action:
    env:
      PROJECT_PATH: functions
    steps:
      - uses: w9jds/firebase-action@v15
        with:
          args: deploy
`,
    });
    expect(directories).toEqual(['.', 'web', 'packages/server', 'packages/api', 'functions']);
  });

  it('skips unparseable workflows and steps that do not deploy', () => {
    expect(
      deployDirectories({
        'broken.yml': 'jobs: [',
        'ci.yml': 'on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n        working-directory: app\n',
      }),
    ).toEqual([]);
  });
});
