import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

test('environment mapping rejects shared projects, missing budgets and demo deployment targets', () => {
  const uri = pathToFileURL(resolve('scripts/check-environment.mjs')).href;
  const source = `
    import { validateProjects } from ${JSON.stringify(uri)};
    import assert from 'node:assert/strict';
    const config = Object.fromEntries(['development','staging','production'].map(name => [name, { projectId: 'synthetic-'+name, region: 'asia-northeast1', budgetApproved: true, maxInstances: 1 }]));
    validateProjects(config);
    for (const override of [{ projectId: config.staging.projectId }, { projectId: 'demo-test-project' }, { budgetApproved: false }, { maxInstances: 0 }, { region: 'us-central1' }]) {
      assert.throws(() => validateProjects({ ...config, development: { ...config.development, ...override } }));
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { encoding: 'utf8' },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
