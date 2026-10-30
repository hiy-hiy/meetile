import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  LOCAL_PORTS,
  LOCAL_REGION,
  localHealthSchema,
} from '../tools/local-development/config.ts';
import { assertRuntimeDirectory } from './local-control.mjs';
import { createReportFixture } from './report-fixture.mjs';
import { Backend } from '../apps/functions/dist/services/backend.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length && !(args.length === 1 && args[0] === '--block'))
  throw new Error(
    'Usage: pnpm local:report-fixture or pnpm local:block-fixture',
  );
const blocking = args[0] === '--block';
const root = resolve('.tools/local-runtime');
await assertRuntimeDirectory(root);
const runId = JSON.parse(
  await readFile(`${root}/server-identity.json`, 'utf8'),
);
const probe = randomUUID();
const response = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}/localHealth?probe=${probe}`,
  { signal: AbortSignal.timeout(8000) },
);
const health = localHealthSchema.parse(await response.json());
if (!response.ok || health.probe !== probe || health.runId !== runId)
  throw new Error('Matching local server required');
Object.assign(process.env, {
  GCLOUD_PROJECT: LOCAL_PROJECT,
  PUZZLE_LOCAL_MODE: 'session-v2',
  PUZZLE_LOCAL_RUN_ID: runId,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${LOCAL_PORTS.auth}`,
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${LOCAL_PORTS.firestore}`,
  FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${LOCAL_PORTS.storage}`,
  STORAGE_EMULATOR_HOST: `http://127.0.0.1:${LOCAL_PORTS.storage}`,
});
for (const name of [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_TOKEN',
  'FIREBASE_CONFIG',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
])
  delete process.env[name];
const app = initializeApp({ projectId: LOCAL_PROJECT }, randomUUID());
let createdTarget = null;
let fixtureDay = null;
try {
  const users = (await getAuth(app).listUsers(blocking ? 3 : 2)).users;
  if (users.length !== (blocking ? 2 : 1))
    throw new Error(
      'Fixture requires one fresh local app user; reset and create an artificial photo first.',
    );
  let ownerUid = users[0].uid;
  if (blocking) {
    const previous = JSON.parse(
      await readFile(`${root}/report-fixture.json`, 'utf8'),
    );
    if (previous.runId !== runId)
      throw new Error('Original fixture runtime required');
    const piece = await getFirestore(app)
      .doc(`pieces/${previous.pieceId}`)
      .get();
    const targetUid = piece.get('ownerUid');
    const nativeOwner = users.find((user) => user.uid !== targetUid);
    if (!nativeOwner || !users.some((user) => user.uid === targetUid))
      throw new Error('Original artificial actors required');
    ownerUid = nativeOwner.uid;
    const originalDay = await new Backend(getFirestore(app)).getDayState(
      ownerUid,
    );
    if (
      originalDay.boardId !== previous.boardId ||
      originalDay.dayKey !== previous.dayKey
    )
      throw new Error('Original artificial board required');
  }
  const day = await new Backend(getFirestore(app)).getDayState(ownerUid);
  if (day.photoState !== 'ready')
    throw new Error('Create an artificial photo before adding the fixture');
  fixtureDay = day.dayKey;
  const target = await getAuth(app).createUser({ uid: randomUUID() });
  createdTarget = target.uid;
  const fixture = await createReportFixture(
    getFirestore(app),
    getStorage(app).bucket(LOCAL_BUCKET),
    ownerUid,
    target.uid,
    blocking ? 'block' : 'report',
  );
  await writeFile(
    `${root}/${blocking ? 'block' : 'report'}-fixture.json`,
    JSON.stringify({ runId, ...fixture }) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Added a server-created artificial safety-test piece. This is a local fixture, not a proximity/FIT test.',
  );
} catch {
  if (createdTarget && fixtureDay) {
    try {
      const membership = await getFirestore(app)
        .doc(`days/${fixtureDay}/members/${createdTarget}`)
        .get();
      if (!membership.exists) await getAuth(app).deleteUser(createdTarget);
    } catch {
      /* Keep the local state for operator reset if cleanup is unavailable. */
    }
  }
  throw new Error(
    'Local safety fixture failed. Report mode requires one artificial-photo user; block mode requires the original two-actor report fixture. No cloud target is supported.',
  );
} finally {
  await deleteApp(app);
}
