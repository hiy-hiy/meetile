import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import {
  getFirestore as clientFirestore,
  connectFirestoreEmulator,
  doc,
  onSnapshot,
  getDoc,
} from 'firebase/firestore';
import {
  getStorage,
  connectStorageEmulator,
  ref,
  getBytes,
} from 'firebase/storage';
import {
  initializeApp as adminApp,
  deleteApp as deleteAdmin,
} from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage as adminStorage } from 'firebase-admin/storage';
import { createReportFixture } from './report-fixture.mjs';
import {
  captureStateSchema,
  dayStateSchema,
  boardViewSchema,
  PHOTO,
} from '../packages/contracts/dist/index.js';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  LOCAL_PORTS,
  LOCAL_REGION,
  LOCAL_TEST_VERSION,
  assertLocalServer,
  localScenarioSchema,
  localHealthSchema,
} from '../tools/local-development/config.ts';

assertLocalServer({ ...process.env, FUNCTIONS_EMULATOR: 'true' });
const scenario = localScenarioSchema.parse(process.env.PUZZLE_LOCAL_SCENARIO);
const sharp = createRequire(
  new URL('../apps/functions/package.json', import.meta.url),
)('sharp');
const admin = adminApp({ projectId: LOCAL_PROJECT }, randomUUID());
const db = getFirestore(admin);
const bucket = adminStorage(admin).bucket(LOCAL_BUCKET);
const endpoint = `http://127.0.0.1:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}`;
const health = localHealthSchema.parse(
  await (await fetch(`${endpoint}/localHealth?probe=${randomUUID()}`)).json(),
);
const apps = [];
async function identity() {
  const app = initializeApp(
    {
      projectId: LOCAL_PROJECT,
      apiKey: 'emulator-only',
      storageBucket: LOCAL_BUCKET,
    },
    randomUUID(),
  );
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://127.0.0.1:${LOCAL_PORTS.auth}`, {
    disableWarnings: true,
  });
  const { user } = await signInAnonymously(auth);
  const token = await user.getIdToken();
  const storage = getStorage(app);
  connectStorageEmulator(storage, '127.0.0.1', LOCAL_PORTS.storage);
  const firestore = clientFirestore(app);
  connectFirestoreEmulator(firestore, '127.0.0.1', LOCAL_PORTS.firestore);
  return {
    token,
    storage,
    firestore,
    uid: user.uid,
    refreshToken: user.refreshToken,
  };
}
async function call(owner, name, data, expected = 200) {
  const response = await fetch(`${endpoint}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${owner.token}`,
    },
    body: JSON.stringify({ data: { runId: health.runId, data } }),
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, expected, `Unexpected HTTP status for ${name}`);
  const payload = await response.json();
  return expected === 200 ? payload.result : payload.error;
}
async function session(owner) {
  await call(owner, 'getDayState', {});
  await call(owner, 'acceptLocalTest', {
    legalVersion: LOCAL_TEST_VERSION,
    accepted: true,
    age16OrOlder: true,
  });
  return captureStateSchema.parse(await call(owner, 'beginCapture', {}));
}
const raw = await sharp({
  create: { width: 240, height: 120, channels: 3, background: '#e67159' },
})
  .withExif({
    IFD0: { Artist: 'synthetic fixture only' },
    IFD3: { GPSLatitudeRef: 'N' },
  })
  .jpeg()
  .toBuffer();
const base64 = raw.toString('base64');
const denied = (error) => error.code === 'storage/unauthorized';
try {
  const owner = await identity();
  const stranger = await identity();
  const capture = await session(owner);
  await session(stranger);
  const upload = { captureId: capture.captureId, base64 };
  const submit = {
    captureId: capture.captureId,
    username: '',
    caption: '赤い四角',
  };
  await call(stranger, 'uploadCapture', upload, 403);
  await call(stranger, 'submitCapture', submit, 403);
  await call(owner, 'uploadCapture', { ...upload, scenario: 'approved' }, 400);
  await call(owner, 'submitCapture', { ...submit, decision: 'approved' }, 400);
  await call(owner, 'uploadCapture', { ...upload, base64: 'not-base64' }, 400);
  await call(
    owner,
    'uploadCapture',
    {
      ...upload,
      base64: Buffer.alloc(PHOTO.maxUploadBytes + 1, 1).toString('base64'),
    },
    400,
  );
  await call(
    owner,
    'submitCapture',
    { ...submit, caption: 'あ'.repeat(141) },
    400,
  );
  assert.equal(
    captureStateSchema.parse(await call(owner, 'submitCapture', submit)).status,
    'open',
  );
  await call(owner, 'uploadCapture', upload);
  await call(owner, 'uploadCapture', upload); // Identical retry must be safe.
  const pending = bucket.file(capture.uploadPath);
  assert.ok(
    !(await pending.getMetadata())[0].metadata?.firebaseStorageDownloadTokens,
  );
  await assert.rejects(
    getBytes(ref(owner.storage, capture.uploadPath)),
    denied,
  );
  const changed = await sharp({
    create: { width: 10, height: 10, channels: 3, background: 'blue' },
  })
    .jpeg()
    .toBuffer();
  await call(
    owner,
    'uploadCapture',
    { ...upload, base64: changed.toString('base64') },
    400,
  );
  if (scenario === 'error-once') {
    assert.equal(
      captureStateSchema.parse(await call(owner, 'submitCapture', submit))
        .status,
      'error',
    );
    assert.equal(
      dayStateSchema.parse(await call(owner, 'getDayState', {})).photoState,
      'not-created',
    );
    assert.equal((await pending.exists())[0], true);
  }
  const expected = scenario === 'error-once' ? 'approved' : scenario;
  const results = await Promise.all([
    call(owner, 'submitCapture', submit),
    call(owner, 'submitCapture', submit),
  ]);
  const completed = captureStateSchema.parse(
    await call(owner, 'getCapture', { captureId: capture.captureId }),
  );
  assert.ok(
    results.every((result) => ['processing', expected].includes(result.status)),
  );
  assert.equal(completed.status, expected);
  assert.equal((await pending.exists())[0], false);
  const day = dayStateSchema.parse(await call(owner, 'getDayState', {}));
  assert.equal(
    day.photoState,
    expected === 'approved' ? 'ready' : 'not-created',
  );
  assert.equal(
    captureStateSchema.parse(await call(owner, 'submitCapture', submit)).status,
    expected,
  );
  if (expected === 'approved') {
    assert.ok(day.ownPieceId && day.boardId);
    const view = boardViewSchema.parse(
      await call(owner, 'syncBoardView', { boardId: day.boardId }),
    );
    assert.equal(view.pieces.length, 1);
    assert.equal(view.pieces[0].id, day.ownPieceId);
    assert.equal(view.pieces[0].caption, submit.caption);
    await call(stranger, 'syncBoardView', { boardId: day.boardId }, 403);
    const viewRef = doc(
      owner.firestore,
      `views/${owner.uid}/boards/${day.boardId}`,
    );
    const observed = await new Promise((resolve, reject) => {
      let stop = () => {};
      const timeout = setTimeout(() => {
        stop();
        reject(new Error('View subscription timed out'));
      }, 10000);
      stop = onSnapshot(
        viewRef,
        (snapshot) => {
          if (snapshot.metadata.fromCache) return;
          clearTimeout(timeout);
          stop();
          resolve(snapshot.data());
        },
        (error) => {
          clearTimeout(timeout);
          stop();
          reject(error);
        },
      );
    });
    assert.deepEqual(boardViewSchema.parse(observed), view);
    await assert.rejects(
      getDoc(
        doc(stranger.firestore, `views/${owner.uid}/boards/${day.boardId}`),
      ),
      (error) => error.code === 'permission-denied',
    );
    const normalized = bucket.file(`normalized/${day.ownPieceId}/image`);
    const metadata = (await normalized.getMetadata())[0];
    assert.equal(metadata.contentType, 'image/jpeg');
    assert.equal(metadata.cacheControl, 'private, no-store');
    assert.ok(!metadata.metadata?.firebaseStorageDownloadTokens);
    const image = (await normalized.download())[0];
    const info = await sharp(image).metadata();
    assert.equal(info.width, PHOTO.pixels);
    assert.equal(info.height, PHOTO.pixels);
    assert.equal(info.exif, undefined);
    await assert.rejects(
      getBytes(ref(stranger.storage, normalized.name)),
      denied,
    );
    // The same participant-only Storage reads are used by the native app.
    assert.deepEqual(
      Buffer.from(await getBytes(ref(owner.storage, normalized.name))),
      image,
    );
    const mediaAddress = `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(normalized.name)}?alt=media`;
    for (const token of [null, stranger.token]) {
      const forbidden = await fetch(mediaAddress, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(forbidden.status, 403);
      await forbidden.arrayBuffer();
    }
    const board = await db.doc(`boards/${day.boardId}`).get();
    assert.equal(board.get('geometry.pieces').length, 1);
    await call(owner, 'beginCapture', {}, 400);
    await call(owner, 'uploadCapture', upload, 400);
    {
      // Screen-wiring check through the real local server: an artificial counterpart, a
      // mutual claim, a one-piece preview and a clean leave. Never confirms, so boards stay put.
      const scan = await call(owner, 'beginFitScan', {});
      const { peerToken } = await call(owner, 'simulatePeer', {
        token: scan.token,
      });
      const matched = await call(owner, 'reportProximity', {
        token: scan.token,
        peerToken,
        method: 'ble',
      });
      assert.equal(matched.status, 'matched');
      const preview = await call(owner, 'getFitPreview', {
        sessionId: matched.sessionId,
      });
      assert.equal(preview.visibility, 'visible');
      assert.equal(preview.username, '人工の相手');
      assert.ok(Buffer.from(preview.imageBase64, 'base64').length > 0);
      assert.ok(!JSON.stringify(preview).includes('local-peer-'));
      await call(
        stranger,
        'getFitPreview',
        { sessionId: matched.sessionId },
        403,
      );
      assert.deepEqual(
        await call(owner, 'leaveFit', { sessionId: matched.sessionId }),
        { cancelled: true },
      );
      await call(owner, 'confirmFit', { sessionId: matched.sessionId }, 400);
      assert.equal((await call(owner, 'getDayState', {})).boardId, day.boardId);
    }
    if (scenario === 'approved' && process.env.PUZZLE_LOCAL_VERIFY_FIXTURE)
      await writeFile(
        `${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.photo`,
        JSON.stringify({
          runId: health.runId,
          refreshToken: owner.refreshToken,
          captureId: capture.captureId,
          boardId: day.boardId,
          pieceId: day.ownPieceId,
          dayKey: day.dayKey,
          hash: createHash('sha256').update(image).digest('hex'),
        }),
        { mode: 0o600 },
      );
  } else if (expected === 'held') {
    assert.ok(!completed.boardId);
    const review = await db.doc(`reviewQueue/${capture.captureId}`).get();
    assert.equal(review.get('status'), 'pending');
    assert.equal(
      (await bucket.file(`review/${capture.captureId}/image`).exists())[0],
      true,
    );
    await assert.rejects(
      getBytes(ref(owner.storage, `review/${capture.captureId}/image`)),
      denied,
    );
  } else {
    const next = captureStateSchema.parse(
      await call(owner, 'beginCapture', {}),
    );
    assert.notEqual(next.captureId, capture.captureId);
  }
  // A broken JPEG and a forbidden synthetic contact must reject in every scenario.
  for (const [input, caption] of [
    [Buffer.from([0xff, 0xd8, 0]), ''],
    [raw, 'https://example.invalid'],
    [raw, '内部検証禁止語'],
  ]) {
    const invalidOwner = await identity();
    const invalidCapture = await session(invalidOwner);
    await call(invalidOwner, 'uploadCapture', {
      captureId: invalidCapture.captureId,
      base64: input.toString('base64'),
    });
    const result = captureStateSchema.parse(
      await call(invalidOwner, 'submitCapture', {
        captureId: invalidCapture.captureId,
        username: '',
        caption,
      }),
    );
    assert.equal(result.status, 'rejected');
    assert.equal(
      dayStateSchema.parse(await call(invalidOwner, 'getDayState', {}))
        .photoState,
      'not-created',
    );
    assert.equal(
      (await bucket.file(invalidCapture.uploadPath).exists())[0],
      false,
    );
  }
  if (scenario === 'approved') {
    const reporter = await identity();
    const reportCapture = await session(reporter);
    await call(reporter, 'uploadCapture', {
      captureId: reportCapture.captureId,
      base64,
    });
    await call(reporter, 'submitCapture', {
      captureId: reportCapture.captureId,
      username: '',
      caption: '通報検証の人工図形',
    });
    const target = await identity();
    const reportFixture = await createReportFixture(
      db,
      bucket,
      reporter.uid,
      target.uid,
    );
    const boardBeforeReport = (
      await db.doc(`boards/${reportFixture.boardId}`).get()
    ).data();
    const reportInput = {
      pieceId: reportFixture.pieceId,
      reason: 'harassment',
    };
    await call(stranger, 'reportPhoto', reportInput, 403);
    await call(target, 'reportPhoto', reportInput, 403);
    await call(
      reporter,
      'reportPhoto',
      { ...reportInput, reporterUid: stranger.uid },
      400,
    );
    await call(
      reporter,
      'reportPhoto',
      { ...reportInput, reason: 'invalid' },
      400,
    );
    const accepted = await Promise.all([
      call(reporter, 'reportPhoto', reportInput),
      call(reporter, 'reportPhoto', reportInput),
    ]);
    assert.ok(
      accepted.every(
        (value) =>
          JSON.stringify(value) === JSON.stringify({ status: 'reported' }),
      ),
    );
    const hidden = boardViewSchema.parse(
      await call(reporter, 'syncBoardView', { boardId: reportFixture.boardId }),
    );
    assert.deepEqual(
      hidden.pieces.find((piece) => piece.id === reportFixture.pieceId),
      {
        ...hidden.pieces.find((piece) => piece.id === reportFixture.pieceId),
        visibility: 'blank',
        photoRef: null,
        username: null,
        caption: null,
      },
    );
    const unaffected = boardViewSchema.parse(
      await call(target, 'syncBoardView', { boardId: reportFixture.boardId }),
    );
    assert.ok(
      unaffected.pieces.every((piece) => piece.visibility === 'visible'),
    );
    assert.deepEqual(
      (await db.doc(`boards/${reportFixture.boardId}`).get()).data(),
      boardBeforeReport,
    );
    const queue = await db
      .collection('reports')
      .where('reporterUid', '==', reporter.uid)
      .get();
    assert.equal(queue.size, 1);
    assert.equal(queue.docs[0].get('reason'), 'harassment');
    assert.ok(
      !Object.keys(queue.docs[0].data()).some((key) =>
        ['caption', 'username', 'image', 'targetUid', 'ownerUid'].includes(key),
      ),
    );
    await assert.rejects(
      getDoc(doc(reporter.firestore, queue.docs[0].ref.path)),
      (error) => error.code === 'permission-denied',
    );
    const address = `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${reportFixture.pieceId}/image`)}?alt=media`;
    const deniedReportImage = await fetch(address, {
      headers: { Authorization: `Bearer ${reporter.token}` },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(deniedReportImage.status, 403);
    await deniedReportImage.arrayBuffer();
    const allowedTargetImage = await fetch(address, {
      headers: { Authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(allowedTargetImage.status, 200);
    await allowedTargetImage.arrayBuffer();
    if (process.env.PUZZLE_LOCAL_VERIFY_FIXTURE)
      await writeFile(
        `${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.reported`,
        JSON.stringify({
          runId: health.runId,
          reporterRefreshToken: reporter.refreshToken,
          targetRefreshToken: target.refreshToken,
          ...reportFixture,
        }),
        { mode: 0o600 },
      );
    console.log(
      'Local report HTTP checks passed: participant-only, private queue, idempotent, reporter-only blanking and revoked image access.',
    );
    const blocker = await identity();
    const blockCapture = await session(blocker);
    await call(blocker, 'uploadCapture', {
      captureId: blockCapture.captureId,
      base64,
    });
    await call(blocker, 'submitCapture', {
      captureId: blockCapture.captureId,
      username: '',
      caption: 'ブロック検証の人工図形',
    });
    const blockObserver = await identity();
    await createReportFixture(db, bucket, blocker.uid, blockObserver.uid);
    const blockTarget = await identity();
    const blockFixture = await createReportFixture(
      db,
      bucket,
      blocker.uid,
      blockTarget.uid,
      'block',
    );
    const ownBlockDay = dayStateSchema.parse(
      await call(blocker, 'getDayState', {}),
    );
    const ownBlockPiece = ownBlockDay.ownPieceId;
    assert.ok(ownBlockPiece);
    const blockInput = { pieceId: blockFixture.pieceId };
    await call(stranger, 'blockPhoto', blockInput, 403);
    await call(blockTarget, 'blockPhoto', blockInput, 403);
    await call(
      blocker,
      'blockPhoto',
      { ...blockInput, ownerUid: stranger.uid },
      400,
    );
    const canonicalBeforeBlock = (
      await db.doc(`boards/${blockFixture.boardId}`).get()
    ).data();
    assert.deepEqual(await call(blocker, 'blockPhoto', blockInput), {
      status: 'blocked',
    });
    await assert.rejects(
      getDoc(
        doc(
          blocker.firestore,
          `views/${blocker.uid}/boards/${blockFixture.boardId}`,
        ),
      ),
      (error) => error.code === 'permission-denied',
    );
    for (const [actor, otherPiece] of [
      [blocker, blockFixture.pieceId],
      [blockTarget, ownBlockPiece],
    ]) {
      const denied = await fetch(
        `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${otherPiece}/image`)}?alt=media`,
        {
          headers: { Authorization: `Bearer ${actor.token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(denied.status, 403);
      await denied.arrayBuffer();
      const v = boardViewSchema.parse(
        await call(actor, 'syncBoardView', { boardId: blockFixture.boardId }),
      );
      assert.deepEqual(
        v.pieces.find((p) => p.id === otherPiece),
        {
          ...v.pieces.find((p) => p.id === otherPiece),
          visibility: 'blank',
          photoRef: null,
          username: null,
          caption: null,
        },
      );
      assert.equal(
        v.pieces.filter((p) => p.visibility === 'visible').length,
        2,
      );
    }
    assert.deepEqual(await call(blocker, 'blockPhoto', blockInput), {
      status: 'blocked',
    });
    const blockDocs = await db.collection('blocks').get();
    assert.equal(blockDocs.size, 1);
    await assert.rejects(
      getDoc(doc(blocker.firestore, blockDocs.docs[0].ref.path)),
      (error) => error.code === 'permission-denied',
    );
    assert.deepEqual(
      (await db.doc(`boards/${blockFixture.boardId}`).get()).data(),
      canonicalBeforeBlock,
    );
    if (process.env.PUZZLE_LOCAL_VERIFY_FIXTURE)
      await writeFile(
        `${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.blocked`,
        JSON.stringify({
          runId: health.runId,
          blockerRefreshToken: blocker.refreshToken,
          targetRefreshToken: blockTarget.refreshToken,
          ownPieceId: ownBlockPiece,
          ...blockFixture,
        }),
        { mode: 0o600 },
      );
    console.log(
      'Local safety-block HTTP checks passed: participant-only, symmetric image denial, private pair, idempotent receipt and unchanged geometry.',
    );
    const deletingOwner = await identity();
    const deletingCapture = await session(deletingOwner);
    await call(deletingOwner, 'uploadCapture', {
      captureId: deletingCapture.captureId,
      base64,
    });
    await call(deletingOwner, 'submitCapture', {
      captureId: deletingCapture.captureId,
      username: '人工削除署名',
      caption: '人工削除図形',
    });
    const before = dayStateSchema.parse(
      await call(deletingOwner, 'getDayState', {}),
    );
    assert.ok(before.ownPieceId && before.boardId);
    const input = { pieceId: before.ownPieceId };
    const geometry = (await db.doc(`boards/${before.boardId}`).get()).data();
    await call(stranger, 'deleteOwnPhoto', input, 403);
    await call(
      deletingOwner,
      'deleteOwnPhoto',
      { ...input, ownerUid: 'forged' },
      400,
    );
    assert.deepEqual(await call(deletingOwner, 'deleteOwnPhoto', input), {
      status: 'deleted',
    });
    assert.deepEqual(await call(deletingOwner, 'deleteOwnPhoto', input), {
      status: 'deleted',
    });
    const after = dayStateSchema.parse(
      await call(deletingOwner, 'getDayState', {}),
    );
    assert.equal(after.photoState, 'unavailable');
    assert.equal(after.boardId, before.boardId);
    assert.equal(after.ownPieceId, before.ownPieceId);
    const blank = boardViewSchema.parse(
      await call(deletingOwner, 'syncBoardView', { boardId: before.boardId }),
    );
    assert.equal(blank.pieces[0].visibility, 'blank');
    assert.equal(blank.pieces[0].photoRef, null);
    assert.equal(blank.pieces[0].username, null);
    assert.equal(blank.pieces[0].caption, null);
    assert.deepEqual(
      (await db.doc(`boards/${before.boardId}`).get()).data(),
      geometry,
    );
    const scrubbed = captureStateSchema.parse(
      await call(deletingOwner, 'getCapture', {
        captureId: deletingCapture.captureId,
      }),
    );
    assert.equal(scrubbed.username, null);
    assert.equal(scrubbed.caption, null);
    await call(deletingOwner, 'beginCapture', {}, 400);
    assert.equal(
      (await bucket.file(`normalized/${before.ownPieceId}/image`).exists())[0],
      false,
    );
    const blocked = await fetch(
      `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${before.ownPieceId}/image`)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${deletingOwner.token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.notEqual(blocked.status, 200);
    await blocked.arrayBuffer();
    if (process.env.PUZZLE_LOCAL_VERIFY_FIXTURE)
      await writeFile(
        `${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.deleted`,
        JSON.stringify({
          runId: health.runId,
          refreshToken: deletingOwner.refreshToken,
          pieceId: before.ownPieceId,
          boardId: before.boardId,
          dayKey: before.dayKey,
        }),
        { mode: 0o600 },
      );
    console.log(
      'Local photo deletion HTTP checks passed: owner-only, idempotent, blank geometry, metadata scrub, physical deletion and no same-day recapture.',
    );
  }
} finally {
  await Promise.allSettled([...apps.map(deleteApp), deleteAdmin(admin)]);
}
console.log(
  `Local photo HTTP checks passed for ${scenario}: real token, owner-only upload, server-only scenario, normalization, private storage, cleanup and idempotent publication.`,
);
