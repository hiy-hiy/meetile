import { randomUUID } from 'node:crypto';
import { AdminModerationService } from '../../apps/functions/src/services/admin-moderation';
import { ReportingService } from '../../apps/functions/src/services/reporting';
import { AccountTerminationService } from '../../apps/functions/src/services/account-termination';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { getBytes, ref, type FirebaseStorage } from 'firebase/storage';
import {
  backend,
  db,
  PROJECT,
  reset,
  seedBoard,
  session,
  safety,
  IN,
  NOW,
} from './helpers';
import { paths } from '../../apps/functions/src/repositories/paths';

let environment: RulesTestEnvironment;
beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: readFileSync('firebase/firestore.rules', 'utf8'),
    },
    storage: {
      host: '127.0.0.1',
      port: 9199,
      rules: readFileSync('firebase/storage.rules', 'utf8'),
    },
  });
});
beforeEach(reset);
afterAll(async () => {
  await environment.cleanup();
});
function firestore(uid: string) {
  return environment.authenticatedContext(uid).firestore();
}
function bytes(uid: string, pieceId: string) {
  // Rules testing returns compat SDKs; modular APIs support their documented _delegate adapter.
  const storage = environment
    .authenticatedContext(uid)
    .storage(`gs://${PROJECT}.appspot.com`) as unknown as FirebaseStorage;
  return getBytes(ref(storage, `normalized/${pieceId}/image`));
}
async function image(pieceId: string, pending = false) {
  const source = `
    const { initializeApp } = require('firebase-admin/app');
    const { getStorage } = require('firebase-admin/storage');
    const app = initializeApp({ projectId: '${PROJECT}', storageBucket: '${PROJECT}.appspot.com' });
    getStorage(app).bucket().file(process.argv[1]).save(Buffer.from([137,80,78,71]), { metadata: { contentType: 'image/png' } }).catch(() => process.exitCode = 1);
  `;
  // Exercise the real Node 22 SDK; Jest's VM cannot load its native ESM transport.
  await promisify(execFile)(
    process.execPath,
    [
      '-e',
      source,
      pending ? 'pending/guessed/source' : `normalized/${pieceId}/image`,
    ],
    { timeout: 30000 },
  );
}

test('FIT progress is readable only by its owner and never writable by clients', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b');
  await db.doc(paths.fitView(a.uid)).set({ stage: 'matched' });
  await assertSucceeds(firestore(a.uid).doc(paths.fitView(a.uid)).get());
  await assertFails(firestore(b.uid).doc(paths.fitView(a.uid)).get());
  await assertFails(
    firestore(a.uid).doc(paths.fitView(a.uid)).set({ stage: 'merged' }),
  );
  await assertFails(firestore(a.uid).collection('fitViews').get());
  await backend.getDayState(a.uid);
  await safety.setSubjectStatus(a.uid, 'suspended');
  await assertFails(firestore(a.uid).doc(paths.fitView(a.uid)).get());
});

test('only a participant can read their projection; no client can read private state or write anything', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b');
  await assertSucceeds(
    firestore(a.uid).doc(paths.view(a.uid, a.boardId)).get(),
  );
  await assertSucceeds(firestore(a.uid).doc(paths.clientState(a.uid)).get());
  await assertFails(firestore(b.uid).doc(paths.view(a.uid, a.boardId)).get());
  await assertFails(
    environment
      .unauthenticatedContext()
      .firestore()
      .doc(paths.view(a.uid, a.boardId))
      .get(),
  );
  for (const path of [
    paths.board(a.boardId),
    paths.piece(a.pieceId),
    paths.subject(a.uid),
    paths.daily('2026-10-10', a.uid),
    paths.media(a.pieceId),
    paths.grant(a.uid, a.boardId),
    paths.block(a.uid, b.uid),
    'fitSessions/guessed',
    'proximityTokens/guessed',
    'rateLimits/guessed',
    'approvals/guessed',
    'reports/guessed',
    'adminOperators/guessed',
    'adminAudit/guessed',
    'adminSessions/guessed',
    'adminDecisions/guessed',
    'adminSuspensions/guessed',
    'adminCaseSuspensions/guessed',
    'captures/guessed',
    'captureOwners/guessed/days/2026-10-10',
    'captureCleanup/guessed',
    'reviewQueue/guessed',
    'consents/guessed',
  ]) {
    await assertFails(firestore(a.uid).doc(path).get());
    await assertFails(firestore(a.uid).doc(path).set({ forged: true }));
  }
  await assertFails(
    firestore(a.uid).doc(paths.view(a.uid, a.boardId)).set({ version: 999 }),
  );
  await assertFails(
    firestore(a.uid).doc(paths.clientState(a.uid)).set({ boardId: b.boardId }),
  );
  await assertFails(firestore(a.uid).collection(`views/${a.uid}/boards`).get());
});

test('Storage get uses two private documents; raw uploads, listing and cross-board reads are rejected', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b');
  await image(a.pieceId);
  expect(new Uint8Array(await assertSucceeds(bytes(a.uid, a.pieceId)))).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  );
  await assertFails(bytes(b.uid, a.pieceId));
  await assertFails(
    environment
      .unauthenticatedContext()
      .storage(`gs://${PROJECT}.appspot.com`)
      .ref(`normalized/${a.pieceId}/image`)
      .getMetadata(),
  );
  const storage = environment
    .authenticatedContext(a.uid)
    .storage(`gs://${PROJECT}.appspot.com`);
  await assertFails(storage.ref('normalized').listAll());
  await assertFails(
    Promise.resolve(
      storage.ref(`normalized/${a.pieceId}/image`).put(new Uint8Array([1])),
    ),
  );
  await assertFails(
    Promise.resolve(
      storage.ref('pending/guessed/source').put(new Uint8Array([1])),
    ),
  );
  await image('unused', true);
  await assertFails(storage.ref('pending/guessed/source').getMetadata());
  const metadata = await assertSucceeds(
    storage.ref(`normalized/${a.pieceId}/image`).getMetadata(),
  );
  expect(
    metadata.customMetadata?.firebaseStorageDownloadTokens,
  ).toBeUndefined();
});

test('block revokes old projection and image rights immediately; resync returns blank content to both viewers', async () => {
  const a = await seedBoard('a', 2);
  const target = a.members[1];
  if (!target) throw new Error('Missing target');
  await image(target.pieceId);
  await image(a.pieceId);
  await assertSucceeds(bytes(a.uid, target.pieceId));
  await safety.blockPhoto(a.uid, { pieceId: target.pieceId });
  await assertFails(firestore(a.uid).doc(paths.view(a.uid, a.boardId)).get());
  await assertFails(bytes(a.uid, target.pieceId));
  await assertFails(bytes(target.uid, a.pieceId));
  const first = await backend.syncBoardView(a.uid, a.boardId);
  const second = await backend.syncBoardView(target.uid, a.boardId);
  expect(
    first.pieces.find((piece) => piece.id === target.pieceId),
  ).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
  expect(
    second.pieces.find((piece) => piece.id === a.pieceId)?.visibility,
  ).toBe('blank');
  await assertSucceeds(
    firestore(a.uid).doc(paths.view(a.uid, a.boardId)).get(),
  );
  await assertFails(bytes(a.uid, target.pieceId));
  await assertSucceeds(bytes(a.uid, a.pieceId));
  const before = (await db.doc(paths.subject(a.uid)).get()).get(
    'accessEpoch',
  ) as unknown;
  await safety.blockPhoto(a.uid, { pieceId: target.pieceId });
  expect((await db.doc(paths.subject(a.uid)).get()).get('accessEpoch')).toEqual(
    before,
  );
});

test('deletion revokes media and old views, clears text and preserves old-day geometry', async () => {
  const a = await seedBoard('past', 2, IN, '2026-10-09');
  const other = a.members[1];
  if (!other) throw new Error('Missing other');
  await image(a.pieceId);
  const before = (await db.doc(paths.board(a.boardId)).get()).data() as unknown;
  await safety.removePiece(a.pieceId);
  await assertFails(bytes(other.uid, a.pieceId));
  await assertFails(
    firestore(other.uid).doc(paths.view(other.uid, a.boardId)).get(),
  );
  const view = await backend.syncBoardView(other.uid, a.boardId);
  expect(view.pieces.find((piece) => piece.id === a.pieceId)).toMatchObject({
    visibility: 'blank',
    username: null,
    caption: null,
    photoRef: null,
  });
  expect((await db.doc(paths.board(a.boardId)).get()).data()).toEqual(before);
  await safety.removePiece(a.pieceId);
  await assertSucceeds(
    firestore(other.uid).doc(paths.view(other.uid, a.boardId)).get(),
  );
});

test('reported-piece hiding affects only the reporter; suspension closes all reads', async () => {
  const a = await seedBoard('a', 2);
  const other = a.members[1];
  if (!other) throw new Error('Missing other');
  await image(other.pieceId);
  await safety.hideReportedPiece(a.uid, other.pieceId);
  await assertFails(bytes(a.uid, other.pieceId));
  expect(
    (await backend.syncBoardView(a.uid, a.boardId)).pieces.find(
      (p) => p.id === other.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect(
    (await backend.syncBoardView(other.uid, a.boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
  await assertSucceeds(bytes(other.uid, other.pieceId));
  await new ReportingService(db, () => NOW).report(a.uid, {
    pieceId: other.pieceId,
    reason: 'other',
  });
  await db.doc('adminOperators/operator').set({ enabled: true });
  await new AdminModerationService(db).suspend('operator', {
    caseId: paths.report(a.uid, other.pieceId).split('/')[1],
    requestId: randomUUID(),
    note: 'Rulesの人工検証',
  });
  await assertFails(bytes(other.uid, other.pieceId));
  await assertFails(
    firestore(other.uid).doc(paths.view(other.uid, a.boardId)).get(),
  );
  await assertFails(
    firestore(other.uid).doc(paths.clientState(other.uid)).get(),
  );
});

test('ending use closes old image paths and views for the ended subject and for others', async () => {
  const a = await seedBoard('ending', 2);
  const other = a.members[1];
  if (!other) throw new Error('Missing other');
  await image(a.pieceId);
  await image(other.pieceId);
  await assertSucceeds(bytes(other.uid, a.pieceId));
  await assertSucceeds(bytes(a.uid, other.pieceId));
  await new AccountTerminationService(
    db,
    { remove: async () => undefined },
    { delete: async () => undefined },
    () => NOW,
  ).end(a.uid, { confirm: true });
  for (const pieceId of [a.pieceId, other.pieceId])
    await assertFails(bytes(a.uid, pieceId));
  await assertFails(firestore(a.uid).doc(paths.view(a.uid, a.boardId)).get());
  await assertFails(firestore(a.uid).doc(paths.clientState(a.uid)).get());
  await assertFails(bytes(other.uid, a.pieceId));
  await assertFails(
    firestore(other.uid).doc(paths.view(other.uid, a.boardId)).get(),
  );
  await backend.syncBoardView(other.uid, a.boardId);
  await assertFails(bytes(other.uid, a.pieceId));
  await assertSucceeds(bytes(other.uid, other.pieceId));
});

test('a stable own-state listener observes a remote board merge without exposing private membership', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const changes: unknown[] = [];
  let merged: ((value: string) => void) | undefined;
  const updated = new Promise<string>((resolve) => {
    merged = resolve;
  });
  const unsubscribe = firestore(a.uid)
    .doc(paths.clientState(a.uid))
    .onSnapshot((snapshot) => {
      const value: unknown = snapshot.data();
      changes.push(value);
      if (
        value &&
        typeof value === 'object' &&
        'boardId' in value &&
        typeof value.boardId === 'string' &&
        value.boardId !== a.boardId
      )
        merged?.(value.boardId);
    });
  try {
    await session('fit', a.uid, b.uid);
    await backend.confirmFit(a.uid, 'fit');
    const result = await backend.confirmFit(b.uid, 'fit');
    if (result.status !== 'merged') throw new Error('Expected merge');
    expect(await updated).toBe(result.boardId);
    expect(JSON.stringify(changes)).not.toContain(b.uid);
  } finally {
    unsubscribe();
  }
});

test('production image adapter saves immutably without permanent download tokens', async () => {
  const source = `
    const {initializeApp}=require('firebase-admin/app');
    const {getStorage}=require('firebase-admin/storage');
    const {GooglePhotoProcessor}=require('./apps/functions/dist/services/photo-processor');
    const sharp=require('./apps/functions/node_modules/sharp');
    const app=initializeApp({projectId:'${PROJECT}',storageBucket:'${PROJECT}.appspot.com'});
    (async()=>{
      const processor=new GooglePhotoProcessor(getStorage(app).bucket(),{textHold:0.5,textReject:0.8,bannedWords:['synthetic']});
      const path='pending/adapter-test/image';
      const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).jpeg().toBuffer();
      await processor.save(path,bytes);await processor.save(path,bytes);
      let immutable=false;try{await processor.save(path,Buffer.from([0xff,0xd8,0]));}catch{immutable=true;}
      const [meta]=await getStorage(app).bucket().file(path).getMetadata();
      console.log(JSON.stringify({tokensAbsent:!meta.metadata?.firebaseStorageDownloadTokens,cacheControl:meta.cacheControl,immutable}));
      await processor.remove(path);
    })().catch(()=>process.exitCode=1);
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', source],
    { timeout: 30000 },
  );
  expect(JSON.parse(stdout)).toEqual({
    tokensAbsent: true,
    cacheControl: 'private, no-store',
    immutable: true,
  });
});
