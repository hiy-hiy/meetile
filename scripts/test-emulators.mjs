import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureFunctionsDependencies } from './functions-dependencies.mjs';
import { writeFile } from 'node:fs/promises';

const project = 'demo-puzzle-sns-development';
await ensureFunctionsDependencies();
await writeFile(
  'apps/functions/deploy/.env.local',
  `PUZZLE_PROJECT_ID=${project}\nPUZZLE_MAX_INSTANCES=1\nPUZZLE_STORAGE_BUCKET=${project}.appspot.com\nPUZZLE_LEGAL_VERSION=test-v1\nPUZZLE_MODERATION_POLICY='{"textHold":0.5,"textReject":0.8,"bannedWords":["禁止語テスト"]}'\n`,
);
const java = spawnSync('java', ['-XshowSettings:properties', '-version'], {
  encoding: 'utf8',
});
const home = java.stderr.match(/java.home = (.+)/)?.[1]?.trim();
if (java.status !== 0 || !home || !/java.version = 21\./.test(java.stderr))
  throw new Error('Emulator tests require JDK 21 on PATH; see docs/PHASE2.md');
const environment = {
  ...process.env,
  JAVA_HOME: home,
  GCLOUD_PROJECT: project,
  PUZZLE_PROJECT_ID: project,
  PUZZLE_MAX_INSTANCES: '1',
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
  XDG_CONFIG_HOME: resolve('.tools/firebase-cli-config'),
  CI: 'true',
};
delete environment.DEBUG;
delete environment.FIREBASE_TOKEN;
delete environment.GOOGLE_APPLICATION_CREDENTIALS;
// Fixed demo namespace prevents missing emulators from falling through to live resources.
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'firebase',
    'emulators:exec',
    '--project',
    project,
    '--config',
    'firebase.json',
    '--only',
    'auth,firestore,storage,functions',
    '--log-verbosity',
    'QUIET',
    'pnpm exec jest --config jest.emulators.config.cjs --runInBand',
  ],
  { env: environment, stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
