import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
} from 'firebase/firestore';
import {
  getStorage,
  connectStorageEmulator,
  ref,
  uploadBytes,
  getBytes,
} from 'firebase/storage';
import {
  dayStateSchema,
  captureStateSchema,
} from '../packages/contracts/dist/index.js';
import {
  LOCAL_PROJECT,
  LOCAL_PORTS,
  localHealthSchema,
  LOCAL_TEST_VERSION,
} from '../tools/local-development/config.ts';

const endpoint = `http://127.0.0.1:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/asia-northeast1/localHealth`;
const probe = randomUUID();
const response = await fetch(`${endpoint}?probe=${probe}`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
const body = localHealthSchema.parse(await response.json());
assert.equal(body.probe, probe);
for (const [suffix, method] of [
  ['', 'GET'],
  ['?probe=invalid', 'GET'],
  [`?probe=${probe}`, 'POST'],
]) {
  const invalid = await fetch(endpoint + suffix, {
    method,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(invalid.status, 400);
}
const wrongProject = await fetch(
  endpoint.replace(LOCAL_PROJECT, 'demo-other-local') + `?probe=${probe}`,
);
assert.notEqual(wrongProject.status, 200);

const apps = [];
async function identity(project = LOCAL_PROJECT, anonymous = true) {
  const app = initializeApp(
    {
      projectId: project,
      apiKey: 'emulator-only',
      storageBucket: `${project}.appspot.com`,
    },
    randomUUID(),
  );
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://127.0.0.1:${LOCAL_PORTS.auth}`, {
    disableWarnings: true,
  });
  const credential = anonymous
    ? await signInAnonymously(auth)
    : await createUserWithEmailAndPassword(
        auth,
        `${randomUUID()}@example.invalid`,
        randomUUID(),
      );
  return {
    app,
    uid: credential.user.uid,
    token: await credential.user.getIdToken(),
    refreshToken: credential.user.refreshToken,
  };
}
const acknowledgement = {
  legalVersion: LOCAL_TEST_VERSION,
  age16OrOlder: true,
  accepted: true,
};
async function call(name, data, token, expected = 200, runId = body.runId) {
  const result = await fetch(endpoint.replace('localHealth', name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data: { runId, data } }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(result.status, expected, `Unexpected HTTP status for ${name}`);
  const payload = await result.json();
  return expected === 200 ? payload.result : payload.error;
}
try {
  for (const [name, input] of [
    ['getDayState', {}],
    ['acceptLocalTest', acknowledgement],
    ['beginCapture', {}],
    ['getCapture', { captureId: 'synthetic' }],
    ['uploadCapture', { captureId: 'synthetic', base64: '/9j/2Q==' }],
    ['submitCapture', { captureId: 'synthetic', username: '', caption: '' }],
    ['syncBoardView', { boardId: 'synthetic' }],
    ['deleteOwnPhoto', { pieceId: 'synthetic' }],
    ['reportPhoto', { pieceId: 'synthetic', reason: 'other' }],
  ]) {
    assert.equal(
      (await call(name, input, null, 401)).status,
      'UNAUTHENTICATED',
    );
  }
  const first = await identity();
  const day = dayStateSchema.parse(await call('getDayState', {}, first.token));
  assert.equal(day.photoState, 'not-created');
  assert.equal(
    day.dayKey,
    new Date(day.serverTimeMs + 5 * 3600000).toISOString().slice(0, 10),
  );
  assert.equal(
    (await call('getDayState', { dayKey: '2000-01-01' }, first.token, 400))
      .status,
    'INVALID_ARGUMENT',
  );
  assert.equal(
    (await call('getDayState', {}, first.token, 400, 'invalid')).status,
    'INVALID_ARGUMENT',
  );
  assert.equal(
    (await call('getDayState', {}, first.token, 400, randomUUID())).status,
    'FAILED_PRECONDITION',
  );
  assert.equal(
    (await call('beginCapture', {}, first.token, 403)).status,
    'PERMISSION_DENIED',
  );
  for (const changed of [
    { legalVersion: 'cloud-terms-v1' },
    { age16OrOlder: false },
    { accepted: false },
  ])
    assert.equal(
      (
        await call(
          'acceptLocalTest',
          { ...acknowledgement, ...changed },
          first.token,
          400,
        )
      ).status,
      'INVALID_ARGUMENT',
    );
  await call('acceptLocalTest', acknowledgement, first.token);
  const sessions = await Promise.all([
    call('beginCapture', {}, first.token),
    call('beginCapture', {}, first.token),
  ]);
  const capture = captureStateSchema.parse(sessions[0]);
  assert.equal(capture.status, 'open');
  assert.equal(capture.dayKey, day.dayKey);
  assert.equal(capture.boardId, null);
  assert.equal(
    captureStateSchema.parse(sessions[1]).captureId,
    capture.captureId,
  );
  assert.deepEqual(
    captureStateSchema.parse(
      await call('getCapture', { captureId: capture.captureId }, first.token),
    ),
    capture,
  );
  const second = await identity();
  await call('getDayState', {}, second.token);
  await call('acceptLocalTest', acknowledgement, second.token);
  assert.equal(
    (
      await call(
        'getCapture',
        { captureId: capture.captureId },
        second.token,
        403,
      )
    ).status,
    'PERMISSION_DENIED',
  );
  // The Auth Emulator ignores API keys/project options for sign-up. Alter the
  // unsigned emulator token's project claims to exercise cross-project rejection.
  const segments = first.token.split('.');
  const claims = JSON.parse(
    Buffer.from(segments[1], 'base64url').toString('utf8'),
  );
  const otherToken = [
    segments[0],
    Buffer.from(
      JSON.stringify({
        ...claims,
        aud: 'demo-other-local',
        iss: 'https://securetoken.google.com/demo-other-local',
      }),
    ).toString('base64url'),
    segments[2],
  ].join('.');
  assert.equal(
    (await call('getDayState', {}, otherToken, 401)).status,
    'UNAUTHENTICATED',
  );
  const password = await identity(LOCAL_PROJECT, false);
  assert.equal(
    (await call('getDayState', {}, password.token, 401)).status,
    'UNAUTHENTICATED',
  );
  const db = getFirestore(first.app);
  connectFirestoreEmulator(db, '127.0.0.1', LOCAL_PORTS.firestore);
  const denied = (error) => error.code === 'permission-denied';
  await assert.rejects(getDoc(doc(db, `subjects/${first.uid}`)), denied);
  await assert.rejects(getDoc(doc(db, `consents/${first.uid}`)), denied);
  await assert.rejects(
    getDoc(doc(db, `captures/${capture.captureId}`)),
    denied,
  );
  await assert.rejects(
    getDoc(doc(db, `views/${second.uid}/boards/synthetic`)),
    denied,
  );
  await assert.rejects(
    setDoc(doc(db, 'boards/synthetic'), { forged: true }),
    denied,
  );
  await assert.rejects(
    setDoc(doc(db, `consents/${first.uid}`), acknowledgement),
    denied,
  );
  assert.equal(
    (await getDoc(doc(db, `clientState/${first.uid}`))).get('dayKey'),
    day.dayKey,
  );
  const storage = getStorage(first.app);
  connectStorageEmulator(storage, '127.0.0.1', LOCAL_PORTS.storage);
  await assert.rejects(
    uploadBytes(
      ref(storage, 'pending/synthetic/image'),
      new Uint8Array([0, 1]),
    ),
    (error) => error.code === 'storage/unauthorized',
  );
  await assert.rejects(
    getBytes(ref(storage, 'pending/synthetic/image')),
    (error) => error.code === 'storage/unauthorized',
  );
  // FIT and Gallery routes exist locally but still refuse callers without a verified identity.
  for (const present of [
    'beginFitScan',
    'reportProximity',
    'getFitPreview',
    'leaveFit',
    'confirmFit',
    'simulatePeer',
    'listGallery',
  ]) {
    const result = await fetch(endpoint.replace('localHealth', present), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert.equal(result.status, 401);
  }
  for (const unavailable of ['acceptOnboarding', 'adminDecision']) {
    const result = await fetch(endpoint.replace('localHealth', unavailable), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert.equal(result.status, 404);
  }
  if (process.env.PUZZLE_LOCAL_VERIFY_FIXTURE)
    await writeFile(
      process.env.PUZZLE_LOCAL_VERIFY_FIXTURE,
      JSON.stringify({
        runId: body.runId,
        uid: first.uid,
        refreshToken: first.refreshToken,
        captureId: capture.captureId,
        dayKey: capture.dayKey,
      }),
      { mode: 0o600 },
    );
} finally {
  await Promise.all(apps.map((app) => deleteApp(app)));
}
console.log(
  'Local HTTP checks passed: anonymous Auth, internal acknowledgement, authoritative day, idempotent capture, run binding, identity isolation, Firestore/Storage Rules, unauthenticated FIT calls refused, and no formal-consent routes.',
);
