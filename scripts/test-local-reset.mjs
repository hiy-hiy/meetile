import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  LOCAL_PORTS,
  LOCAL_REGION,
  LOCAL_TEST_VERSION,
  localHealthSchema,
} from '../tools/local-development/config.ts';
import { requestLocalReset } from './local-control.mjs';

// All processes use the same demo project/ports but this distinct snapshot root.
const root = resolve('.tools/local-runtime/reset-verification');
const normalRoot = resolve('.tools/local-runtime');
const digest = async (path) => {
  const bytes = await readFile(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
};
const preserved = [
  'server-identity.json',
  'data/firebase-export-metadata.json',
];
const before = await Promise.all(
  preserved.map((path) => digest(`${normalRoot}/${path}`)),
);
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${LOCAL_PORTS.auth}`;
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${LOCAL_PORTS.firestore}`;
process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${LOCAL_PORTS.storage}`;
const app = initializeApp({ projectId: LOCAL_PROJECT }, randomUUID());
const db = getFirestore(app);
const bucket = getStorage(app).bucket(LOCAL_BUCKET);
const endpoint = `http://127.0.0.1:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}`;
let child;
let exit;
function start() {
  child = spawn(
    process.execPath,
    ['scripts/local-server.mjs', '--test-reset'],
    { stdio: 'inherit' },
  );
  exit = new Promise((resolveExit, reject) => {
    child.once('exit', (code) => resolveExit(code));
    child.once('error', reject);
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const code = await exit;
  assert.equal(code, 0, 'Local reset verification must stop/export cleanly');
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child?.kill(signal));
async function health(expected) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    assert.equal(
      child.exitCode,
      null,
      'Verification server exited unexpectedly',
    );
    try {
      const probe = randomUUID();
      const response = await fetch(`${endpoint}/localHealth?probe=${probe}`, {
        signal: AbortSignal.timeout(3000),
      });
      const state = localHealthSchema.parse(await response.json());
      if (
        response.ok &&
        state.probe === probe &&
        (!expected || state.runId === expected)
      )
        return state;
    } catch {
      /* Startup has not completed. */
    }
    await setTimeout(1000);
  }
  throw new Error('Reset verification startup timed out');
}
async function identity() {
  const response = await fetch(
    `http://127.0.0.1:${LOCAL_PORTS.auth}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(response.status, 200);
  return response.json();
}
async function call(runId, token, name, data, status = 200) {
  const response = await fetch(`${endpoint}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data: { runId, data } }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    status,
    `Unexpected reset HTTP status for ${name}`,
  );
  const payload = await response.json();
  return status === 200 ? payload.result : payload.error;
}
try {
  start();
  const first = await health();
  const old = await identity();
  await call(first.runId, old.idToken, 'getDayState', {});
  await db.doc('localResetFixture/only').set({ artificial: true });
  await bucket.file('pending/reset-fixture/image').save('synthetic bytes only');
  await assert.rejects(
    requestLocalReset(root, {
      action: 'reset',
      projectId: LOCAL_PROJECT,
      runId: randomUUID(),
    }),
  );
  assert.equal((await db.doc('localResetFixture/only').get()).exists, true);
  const simultaneous = await Promise.allSettled(
    [0, 1].map(() =>
      requestLocalReset(root, {
        action: 'reset',
        projectId: LOCAL_PROJECT,
        runId: first.runId,
        scenario: 'held',
      }),
    ),
  );
  const accepted = simultaneous.filter(
    (result) => result.status === 'fulfilled',
  );
  assert.equal(
    accepted.length,
    1,
    'Only one simultaneous reset may be accepted',
  );
  assert.equal(
    simultaneous.filter((result) => result.status === 'rejected').length,
    1,
  );
  const next = accepted[0].value;
  assert.notEqual(next, first.runId);
  await health(next);
  assert.equal((await getAuth(app).listUsers()).users.length, 0);
  assert.equal((await db.doc('localResetFixture/only').get()).exists, false);
  assert.equal((await db.collection('subjects').get()).empty, true);
  assert.equal((await bucket.getFiles())[0].length, 0);
  await call(first.runId, old.idToken, 'getDayState', {}, 400);
  const fresh = await identity();
  await call(next, fresh.idToken, 'getDayState', {});
  await call(next, fresh.idToken, 'acceptLocalTest', {
    age16OrOlder: true,
    accepted: true,
    legalVersion: LOCAL_TEST_VERSION,
  });
  const capture = await call(next, fresh.idToken, 'beginCapture', {});
  const sharp = createRequire(resolve('apps/functions/package.json'))('sharp');
  const image = await sharp({
    create: { width: 40, height: 40, channels: 3, background: 'orange' },
  })
    .jpeg()
    .toBuffer();
  await call(next, fresh.idToken, 'uploadCapture', {
    captureId: capture.captureId,
    base64: image.toString('base64'),
  });
  const result = await call(next, fresh.idToken, 'submitCapture', {
    captureId: capture.captureId,
    username: '',
    caption: '人工の四角',
  });
  assert.equal(
    result.status,
    'held',
    'Requested reset scenario must apply to the new process',
  );
  assert.equal(result.boardId, null);
  await stop();
  start();
  await health(next);
  const restored = await call(next, fresh.idToken, 'getCapture', {
    captureId: capture.captureId,
  });
  assert.equal(restored.status, 'held');
  assert.equal(restored.captureId, capture.captureId);
  await stop();
  assert.deepEqual(
    await Promise.all(preserved.map((path) => digest(`${normalRoot}/${path}`))),
    before,
  );
  await rm(root, { recursive: true, force: true });
  console.log(
    'Local reset HTTP checks passed: owned shutdown, all three stores cleared, run rotation, stale request rejection, scenario switch, ordinary restart preservation, normal snapshot untouched.',
  );
} finally {
  await stop();
  await deleteApp(app);
}
