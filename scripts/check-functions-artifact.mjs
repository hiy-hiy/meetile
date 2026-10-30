import { mkdtemp, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'puzzle-functions-artifact-'));
try {
  for (const name of ['index.js', 'package.json', 'package-lock.json'])
    await copyFile(`apps/functions/deploy/${name}`, join(directory, name));
  const bundle = await readFile(join(directory, 'index.js'), 'utf8');
  if (/require\(["']@puzzle-sns\//.test(bundle))
    throw new Error('Unbundled workspace dependency');
  const install = spawnSync(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: directory, encoding: 'utf8', timeout: 300000 },
  );
  if (install.status !== 0)
    throw new Error(
      'Standalone artifact dependency installation failed: ' + install.stderr,
    );
  const check = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const functions = require('./index.js');
    assert.deepEqual(Object.keys(functions).sort(), ['acceptOnboarding', 'beginCapture', 'beginFitScan', 'blockPhoto', 'cleanupCaptures', 'cleanupDeletedPhotos', 'confirmFit', 'deleteOwnPhoto', 'endUse', 'getCapture', 'getDayState', 'getFitPreview', 'leaveFit', 'listGallery', 'processAccountTerminations', 'reportPhoto', 'reportProximity', 'submitCapture', 'syncBoardView', 'uploadCapture']);
    const callables = Object.values(functions).filter(fn => fn.__endpoint.callableTrigger);
    assert.ok(functions.cleanupCaptures.__endpoint.scheduleTrigger);
    assert.ok(functions.cleanupDeletedPhotos.__endpoint.scheduleTrigger);
    assert.ok(functions.processAccountTerminations.__endpoint.scheduleTrigger);
    for (const fn of callables) {
      assert.equal(fn.__endpoint.platform, 'gcfv2');
      assert.ok(fn.__endpoint.callableTrigger);
      assert.deepEqual(fn.__endpoint.region, ['asia-northeast1']);
    }
    const caller = { data: {}, auth: { uid: 'synthetic', token: { firebase: { sign_in_provider: 'anonymous' } } } };
    (async () => {
      for (const fn of callables) {
        await assert.rejects(fn.run(caller), { code: 'permission-denied' });
      }
      process.env.GCLOUD_PROJECT = 'demo-puzzle-sns-staging';
      for (const fn of callables) {
        await assert.rejects(fn.run({ ...caller, app: { appId: 'synthetic-app' } }), { code: 'permission-denied' });
      }
      console.log('Standalone Functions artifact loads; all handlers reject missing App Check and project mismatches.');
    })().catch(() => process.exitCode = 1);
  `,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        GCLOUD_PROJECT: 'demo-puzzle-sns-development',
        PUZZLE_PROJECT_ID: 'demo-puzzle-sns-development',
        PUZZLE_MAX_INSTANCES: '1',
      },
      encoding: 'utf8',
    },
  );
  if (check.status !== 0) throw new Error(check.stderr);
  console.log(check.stdout.trim());
} finally {
  await rm(directory, { recursive: true, force: true });
}
