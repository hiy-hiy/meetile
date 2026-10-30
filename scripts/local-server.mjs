import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  LOCAL_PROJECT,
  LOCAL_PORTS,
  localScenarioSchema,
} from '../tools/local-development/config.ts';
import {
  assertRuntimeDirectory,
  assertLocalSnapshotPaths,
  deleteLocalSnapshot,
  serveLocalControl,
  waitForLocalPorts,
} from './local-control.mjs';

const args = process.argv.slice(2).filter((value) => value !== '--');
if (
  args.length &&
  !(args.length === 1 && ['--test', '--test-admin'].includes(args[0])) &&
  !(args.length === 1 && args[0] === '--test-reset') &&
  !(args.length === 2 && args[0] === '--scenario')
)
  throw new Error(
    'Usage: pnpm local:server [--scenario approved|rejected|held|error-once] or pnpm test:local',
  );
const adminTesting = args[0] === '--test-admin';
const testing = args[0] === '--test' || adminTesting;
const resetVerification = args[0] === '--test-reset';
let scenario = localScenarioSchema.parse(
  args[0] === '--scenario' ? args[1] : 'approved',
);
const firebaseCli = createRequire(import.meta.url).resolve(
  'firebase-tools/lib/bin/firebase.js',
);
const java = spawnSync('java', ['-XshowSettings:properties', '-version'], {
  encoding: 'utf8',
});
const javaHome = java.stderr.match(/java.home = (.+)/)?.[1]?.trim();
if (java.status !== 0 || !javaHome || !/java.version = 21\./.test(java.stderr))
  throw new Error(
    'Local emulators require JDK 21 on PATH; see docs/PHASE3_LOCAL_SETUP.md',
  );

for (const port of Object.values(LOCAL_PORTS)) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(
        new Error(`Port ${port} is in use; no existing process was stopped.`),
      ),
    );
    server.listen(port, '0.0.0.0', () => server.close(resolvePromise));
  });
}
for (const [command, args] of [
  ['pnpm', ['build']],
  [process.execPath, ['scripts/build-local-functions.mjs']],
]) {
  if (spawnSync(command, args, { stdio: 'inherit' }).status !== 0)
    process.exit(1);
}
const root = resolve(
  resetVerification
    ? '.tools/local-runtime/reset-verification'
    : '.tools/local-runtime',
);
await mkdir(root, { recursive: true });
await assertRuntimeDirectory(root);
await assertLocalSnapshotPaths(root);
await mkdir(`${root}/rules`, { recursive: true });
for (const file of [
  'firestore.rules',
  'firestore.indexes.json',
  'storage.rules',
])
  await copyFile(`firebase/${file}`, `${root}/rules/${file}`);
const snapshot = `${root}/data`;
let importing =
  !testing && existsSync(`${snapshot}/firebase-export-metadata.json`);
const identityFile = `${root}/server-identity.json`;
const verification = `${root}/verification`;
if (testing) {
  await rm(verification, { recursive: true, force: true });
  await mkdir(verification, { recursive: true });
}
let runId = importing
  ? z.uuid().parse(JSON.parse(await readFile(identityFile, 'utf8')))
  : randomUUID();
if (!testing) await writeFile(identityFile, JSON.stringify(runId) + '\n');
const config = {
  firestore: {
    rules: 'rules/firestore.rules',
    indexes: 'rules/firestore.indexes.json',
  },
  storage: { rules: 'rules/storage.rules' },
  functions: [
    {
      source: resetVerification ? '../functions' : 'functions',
      codebase: 'local-session',
      runtime: 'nodejs22',
    },
  ],
  emulators: {
    auth: {
      host: testing || resetVerification ? '127.0.0.1' : '0.0.0.0',
      port: LOCAL_PORTS.auth,
    },
    firestore: {
      host: testing || resetVerification ? '127.0.0.1' : '0.0.0.0',
      port: LOCAL_PORTS.firestore,
      websocketPort: LOCAL_PORTS.firestoreWebsocket,
    },
    storage: {
      host: testing || resetVerification ? '127.0.0.1' : '0.0.0.0',
      port: LOCAL_PORTS.storage,
    },
    functions: {
      host: testing || resetVerification ? '127.0.0.1' : '0.0.0.0',
      port: LOCAL_PORTS.functions,
    },
    hub: { host: '127.0.0.1', port: LOCAL_PORTS.hub },
    logging: { host: '127.0.0.1', port: LOCAL_PORTS.logging },
    eventarc: { host: '127.0.0.1', port: LOCAL_PORTS.eventarc },
    tasks: { host: '127.0.0.1', port: LOCAL_PORTS.tasks },
    ui: { enabled: false },
    singleProjectMode: true,
  },
};
await writeFile(
  `${root}/firebase.json`,
  JSON.stringify(config, null, 2) + '\n',
);
const environment = {
  ...process.env,
  XDG_CONFIG_HOME: resolve('.tools/firebase-cli-local'),
  GCLOUD_PROJECT: LOCAL_PROJECT,
  PUZZLE_LOCAL_MODE: 'session-v2',
  PUZZLE_LOCAL_RUN_ID: runId,
  JAVA_HOME: javaHome,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${LOCAL_PORTS.auth}`,
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${LOCAL_PORTS.firestore}`,
  FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${LOCAL_PORTS.storage}`,
  STORAGE_EMULATOR_HOST: `http://127.0.0.1:${LOCAL_PORTS.storage}`,
  ...(testing
    ? { PUZZLE_LOCAL_VERIFY_FIXTURE: `${verification}/fixture.json` }
    : {}),
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
};
for (const name of [
  'FIREBASE_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_CONFIG',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'DEBUG',
])
  delete environment[name];
console.log(
  `Starting local emulators with synthetic photo scenario: ${scenario}. No real moderation is performed.`,
);
const baseArgs = [
  testing ? 'emulators:exec' : 'emulators:start',
  '--only',
  'auth,firestore,storage,functions',
  '--project',
  LOCAL_PROJECT,
  '--config',
  `${root}/firebase.json`,
  '--non-interactive',
  '--log-verbosity',
  'QUIET',
];
const runs = adminTesting
  ? [{ scenario: 'approved', args: ['node scripts/test-admin-http.mjs'] }]
  : testing
    ? [
        {
          scenario: 'approved',
          args: [
            '--export-on-exit',
            `${verification}/data`,
            'node scripts/test-local-connection.mjs && node scripts/test-local-photos.mjs',
          ],
        },
        {
          scenario: 'approved',
          args: [
            '--import',
            `${verification}/data`,
            'node scripts/test-local-persistence.mjs',
          ],
        },
        ...['rejected', 'held', 'error-once'].map((scenario) => ({
          scenario,
          args: ['node scripts/test-local-photos.mjs'],
        })),
      ]
    : [
        {
          scenario,
          args: [
            ...(importing ? ['--import', snapshot] : []),
            '--export-on-exit',
            snapshot,
          ],
        },
      ];
let child;
let stopping = false;
let pendingReset = null;
const closeControl = testing
  ? null
  : await serveLocalControl(root, (request) => {
      if (stopping || pendingReset || !child?.pid || request.runId !== runId)
        throw new Error('Local reset is not available');
      return new Promise((resolveReset, rejectReset) => {
        pendingReset = { request, resolveReset, rejectReset };
        if (!child.kill('SIGTERM')) {
          pendingReset = null;
          rejectReset(new Error('Local emulator did not stop'));
        }
      });
    });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
for (let index = 0; index < runs.length; index++) {
  const run = runs[index];
  const code = await new Promise((resolveCode) => {
    child = spawn(process.execPath, [firebaseCli, ...baseArgs, ...run.args], {
      env: { ...environment, PUZZLE_LOCAL_SCENARIO: run.scenario },
      stdio: 'inherit',
    });
    child.once('exit', (value) => resolveCode(value ?? 1));
    child.once('error', () => {
      console.error('Local emulator failed to start.');
      resolveCode(1);
    });
  });
  process.exitCode = code;
  if (code === 0) {
    try {
      await waitForLocalPorts();
    } catch (error) {
      pendingReset?.rejectReset(error);
      pendingReset = null;
      process.exitCode = 1;
      console.error(
        'Local emulator ports did not close; no other process was stopped.',
      );
      break;
    }
  }
  if (pendingReset && code === 0 && !stopping) {
    const reset = pendingReset;
    try {
      // Delete only after the owned child has finished its export and exited.
      await deleteLocalSnapshot(root);
      runId = randomUUID();
      await writeFile(identityFile, JSON.stringify(runId) + '\n');
      importing = false;
      environment.PUZZLE_LOCAL_RUN_ID = runId;
      scenario = reset.request.scenario ?? scenario;
      runs.push({ scenario, args: ['--export-on-exit', snapshot] });
      reset.resolveReset(runId);
      console.log(
        `Local test data reset; restarting with scenario: ${scenario}.`,
      );
    } catch {
      reset.rejectReset(
        new Error('Local reset failed; data was not restarted'),
      );
      process.exitCode = 1;
      break;
    } finally {
      pendingReset = null;
    }
    continue;
  }
  pendingReset?.rejectReset(new Error('Local emulators did not exit cleanly'));
  pendingReset = null;
  if (code !== 0 || stopping) break;
}
await closeControl?.();
if (testing && process.exitCode === 0)
  await rm(verification, { recursive: true, force: true });
if (testing && !adminTesting && process.exitCode === 0)
  process.exitCode = await new Promise((resolveCode) => {
    child = spawn(process.execPath, ['scripts/test-local-reset.mjs'], {
      stdio: 'inherit',
    });
    child.once('exit', (code) => resolveCode(code ?? 1));
    child.once('error', () => resolveCode(1));
  });
