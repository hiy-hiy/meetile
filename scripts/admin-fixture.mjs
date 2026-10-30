import { Buffer } from 'node:buffer';
import { URL, URLSearchParams } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  assertLocalServer,
} from '../tools/local-development/config.ts';
import { Backend } from '../apps/functions/dist/services/backend.js';
import { ReportingService } from '../apps/functions/dist/services/reporting.js';
import { PhotoStorage } from '../apps/functions/dist/services/photo-storage.js';
import { CaptureService } from '../apps/functions/dist/services/capture.js';
import { paths } from '../apps/functions/dist/repositories/paths.js';
import { createReportFixture } from './report-fixture.mjs';

export function adminLocalEnvironment(runId) {
  const environment = {
    ...process.env,
    GCLOUD_PROJECT: LOCAL_PROJECT,
    PUZZLE_LOCAL_MODE: 'session-v2',
    PUZZLE_LOCAL_RUN_ID: runId,
    PUZZLE_ADMIN_MODE: 'local',
    PUZZLE_ADMIN_PROJECT_ID: LOCAL_PROJECT,
    PUZZLE_ADMIN_BUCKET: LOCAL_BUCKET,
    PUZZLE_ADMIN_ORIGIN: 'http://127.0.0.1:3002',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
    STORAGE_EMULATOR_HOST: 'http://127.0.0.1:19199',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  for (const key of [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'FIREBASE_TOKEN',
    'FIREBASE_CONFIG',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'PUZZLE_ADMIN_FIREBASE_WEB',
  ])
    delete environment[key];
  assertLocalServer({ ...environment, FUNCTIONS_EMULATOR: 'true' });
  return environment;
}
function assertFixture(app) {
  assertLocalServer({ ...process.env, FUNCTIONS_EMULATOR: 'true' });
  if (
    app.options.projectId !== LOCAL_PROJECT ||
    process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:18080' ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19099'
  )
    throw new Error('Fixed local admin fixture required');
}
export async function syntheticGoogleCredential(
  sub = 'puzzle-sns-local-operator',
  email = 'operator@example.invalid',
) {
  assertLocalServer({ ...process.env, FUNCTIONS_EMULATOR: 'true' });
  const now = Math.floor(Date.now() / 1000);
  const token =
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    ) +
    '.' +
    Buffer.from(
      JSON.stringify({
        sub,
        email,
        email_verified: true,
        iss: 'https://accounts.google.com',
        aud: 'synthetic-client',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url') +
    '.';
  const response = await fetch(
    'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator-only',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postBody: new URLSearchParams({
          id_token: token,
          providerId: 'google.com',
        }).toString(),
        requestUri: 'http://127.0.0.1:3002',
        returnSecureToken: true,
      }),
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error('Synthetic operator sign-in failed');
  return response.json();
}
export async function prepareLocalOperator(app) {
  assertFixture(app);
  const credential = await syntheticGoogleCredential();
  const decoded = await getAuth(app).verifyIdToken(credential.idToken);
  await getFirestore(app)
    .doc(`adminOperators/${decoded.uid}`)
    .set({ enabled: true });
  return { uid: decoded.uid, idToken: credential.idToken };
}
export async function createAdminFixture(app, label, actors) {
  assertFixture(app);
  if (!['A', 'B', 'C'].includes(label))
    throw new Error('Artificial fixture label required');
  const db = getFirestore(app),
    backend = new Backend(db),
    bucket = getStorage(app).bucket(LOCAL_BUCKET);
  const owner = actors
      ? await getAuth(app).getUser(actors.ownerUid)
      : await getAuth(app).createUser({ uid: randomUUID() }),
    target = actors
      ? await getAuth(app).getUser(actors.targetUid)
      : await getAuth(app).createUser({ uid: randomUUID() });
  const day = await backend.getDayState(owner.uid),
    pieceId = randomUUID(),
    approvalId = randomUUID();
  const sharp = createRequire(
    new URL('../apps/functions/package.json', import.meta.url),
  )('sharp');
  const image = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#c9d9e4' },
  })
    .jpeg()
    .toBuffer();
  await new PhotoStorage(bucket).save(`normalized/${pieceId}/image`, image);
  await db.doc(paths.approval(approvalId)).create({
    ownerUid: owner.uid,
    dayKey: day.dayKey,
    status: 'approved',
    normalizedPieceId: pieceId,
    username: '人工素材の検証者',
    caption: 'Macで生成した単色画像です。',
  });
  await backend.publishApprovedPiece(approvalId);
  const fixture = await createReportFixture(db, bucket, owner.uid, target.uid);
  await db.doc(paths.piece(fixture.pieceId)).update({
    username: `管理画面テスト ${label}`,
    caption: 'Macで生成した人工図形です。実在する人物や個人情報は含みません。',
  });
  await new ReportingService(db).report(owner.uid, {
    pieceId: fixture.pieceId,
    reason: 'other',
  });
  return {
    ...fixture,
    ownPieceId: pieceId,
    caseId: paths.report(owner.uid, fixture.pieceId).split('/')[1],
  };
}
/** A capture the (artificial) automatic moderation held for human review. */
export async function createHeldFixture(app, label) {
  assertFixture(app);
  if (!['A', 'B'].includes(label))
    throw new Error('Artificial fixture label required');
  const db = getFirestore(app),
    storage = new PhotoStorage(getStorage(app).bucket(LOCAL_BUCKET));
  const owner = await getAuth(app).createUser({ uid: randomUUID() });
  const sharp = createRequire(
    new URL('../apps/functions/package.json', import.meta.url),
  )('sharp');
  const image = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#e4d2c9' },
  })
    .jpeg()
    .toBuffer();
  const capture = new CaptureService(
    db,
    {
      has: (path) => storage.has(path),
      save: (path, value) => storage.save(path, value),
      remove: (path) => storage.remove(path),
      process: async () => ({ decision: 'held', image }),
    },
    'admin-held-fixture',
  );
  await new Backend(db).getDayState(owner.uid);
  await capture.acceptOnboarding(owner.uid, {
    age16OrOlder: true,
    accepted: true,
    legalVersion: 'admin-held-fixture',
  });
  const begun = await capture.begin(owner.uid);
  await capture.upload(owner.uid, {
    captureId: begun.captureId,
    base64: image.toString('base64'),
  });
  const result = await capture.submit(owner.uid, {
    captureId: begun.captureId,
    username: `保留テスト ${label}`,
    caption: 'Macで生成した人工図形です。実在する人物や個人情報は含みません。',
  });
  if (result.status !== 'held') throw new Error('Held fixture not created');
  const pieceId = String(
    (await db.doc(`captures/${begun.captureId}`).get()).get('pieceId'),
  );
  return { caseId: begun.captureId, ownerUid: owner.uid, pieceId };
}
