import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AccountTerminationService,
  type Principals,
} from '../../apps/functions/src/services/account-termination';
import { CaptureService } from '../../apps/functions/src/services/capture';
import { PhotoDeletionService } from '../../apps/functions/src/services/photo-deletion';
import { paths } from '../../apps/functions/src/repositories/paths';
import {
  db,
  reset,
  backend,
  safety,
  seedBoard,
  session,
  OUT,
  IN,
  NOW,
  DAY,
  PROJECT,
} from './helpers';

const PAST = '2026-10-09';
class ArtificialPhotos {
  objects = new Set<string>();
  failRemoval = false;
  async remove(path: string) {
    if (this.failRemoval) throw new Error('Synthetic storage outage');
    this.objects.delete(path);
  }
}
class ArtificialPrincipals implements Principals {
  deleted: string[] = [];
  fail = false;
  async delete(uid: string) {
    if (this.fail) throw new Error('Synthetic Auth outage');
    this.deleted.push(uid);
  }
}
let photos: ArtificialPhotos;
let principals: ArtificialPrincipals;
let service: AccountTerminationService;
beforeEach(async () => {
  await reset();
  photos = new ArtificialPhotos();
  principals = new ArtificialPrincipals();
  service = new AccountTerminationService(db, photos, principals, () => NOW);
});
const image = (pieceId: string) => `normalized/${pieceId}/image`;
async function documents(collection: string) {
  return (await db.collection(collection).get()).docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
  }));
}
async function subtree(root: string, uid: string) {
  return (await db.collection(root).doc(uid).listCollections()).length;
}
async function merge(id: string, first: string, second: string) {
  await session(id, first, second);
  await backend.confirmFit(first, id);
  const outcome = await backend.confirmFit(second, id);
  if (outcome.status !== 'merged') throw new Error('Bad synthetic merge');
  return outcome.boardId;
}
/** Leaver owns a past-day piece and a piece in today's merged board. */
async function scenario() {
  const past = await seedBoard('end-past', 2, OUT, PAST, [
    'leaver',
    'past-friend',
  ]);
  const a = await seedBoard('end-a', 1, OUT, DAY, ['leaver']);
  const b = await seedBoard('end-b', 1, IN, DAY, ['friend']);
  const merged = await merge('end-join', a.uid, b.uid);
  const pastFriend = past.members[1];
  if (!pastFriend) throw new Error('Missing artificial member');
  for (const piece of [past.pieceId, pastFriend.pieceId, a.pieceId, b.pieceId])
    photos.objects.add(image(piece));
  return { past, pastFriend, a, b, merged };
}

test('ending blanks every day’s own photo, deletes client data and the principal, and keeps geometry and safety records', async () => {
  const s = await scenario();
  await safety.block('leaver', 'past-friend');
  const unpublished = randomUUID();
  await Promise.all([
    db.doc('consents/leaver').set({ accepted: true, age16OrOlder: true }),
    db.doc(paths.hidden('leaver', s.b.pieceId)).set({ hidden: true }),
    db
      .doc(`captureOwners/leaver/days/${DAY}`)
      .set({ captureId: 'leaver-open' }),
    db.doc('captures/leaver-open').set({
      ownerUid: 'leaver',
      pieceId: unpublished,
      dayKey: DAY,
      status: 'rejected',
      uploadPath: 'pending/leaver-open/image',
      boardId: null,
      username: '人工署名',
      caption: '人工文章',
      leaseToken: null,
      leaseUntilMs: 0,
      expiresAtMs: NOW + 3600000,
    }),
    db.doc('approvals/leaver-stale').set({
      ownerUid: 'leaver',
      dayKey: DAY,
      status: 'approved',
      normalizedPieceId: unpublished,
      username: '人工署名',
      caption: '人工文章',
    }),
    db.doc('reviewQueue/leaver-held').set({
      captureId: 'leaver-held',
      ownerUid: 'leaver',
      dayKey: DAY,
      status: 'pending',
      imagePath: 'review/leaver-held/image',
      username: '保留署名',
      caption: '保留文章',
    }),
    db.doc('reports/by-leaver').set({ reporterUid: 'leaver' }),
    db.doc('reports/about-leaver').set({ pieceId: s.a.pieceId }),
  ]);
  for (const path of [
    'pending/leaver-open/image',
    image(unpublished),
    'review/leaver-held/image',
  ])
    photos.objects.add(path);
  const boards = await documents('boards');
  const dailies = await Promise.all(
    [PAST, DAY].map(async (day) =>
      (await db.doc(paths.daily(day, 'leaver')).get()).data(),
    ),
  );
  const retained = await Promise.all(
    ['reports', 'blocks', 'reviewQueue'].map(documents),
  );

  expect(await service.end('leaver', { confirm: true })).toEqual({
    status: 'ended',
  });

  expect((await db.doc(paths.subject('leaver')).get()).get('status')).toBe(
    'ended',
  );
  for (const pieceId of [s.past.pieceId, s.a.pieceId]) {
    expect((await db.doc(paths.piece(pieceId)).get()).data()).toMatchObject({
      status: 'deleted',
      username: null,
      caption: null,
    });
    expect((await db.doc(paths.media(pieceId)).get()).data()).toEqual({
      visible: false,
      epochs: {},
    });
    expect(photos.objects.has(image(pieceId))).toBe(false);
  }
  expect(await documents('boards')).toEqual(boards);
  for (const [index, day] of [PAST, DAY].entries())
    expect((await db.doc(paths.daily(day, 'leaver')).get()).data()).toEqual(
      dailies[index],
    );
  // Every remaining participant's historical display copy is scrubbed.
  for (const board of boards)
    for (const member of board.data.members as { uid: string }[]) {
      if (member.uid === 'leaver') continue;
      const view = await db.doc(paths.view(member.uid, board.id)).get();
      for (const piece of view.get('pieces') as {
        id: string;
        visibility: string;
        username: string | null;
      }[])
        if ([s.past.pieceId, s.a.pieceId].includes(piece.id))
          expect(piece).toMatchObject({ visibility: 'blank', username: null });
    }
  const friendView = await backend.syncBoardView('friend', s.merged);
  expect(friendView.pieces.find((p) => p.id === s.a.pieceId)?.visibility).toBe(
    'blank',
  );
  expect(friendView.pieces.find((p) => p.id === s.b.pieceId)?.visibility).toBe(
    'visible',
  );
  expect(photos.objects.has(image(s.b.pieceId))).toBe(true);
  expect(photos.objects.has(image(s.pastFriend.pieceId))).toBe(true);

  for (const root of ['views', 'viewGrants', 'hidden', 'captureOwners'])
    expect(await subtree(root, 'leaver')).toBe(0);
  for (const path of [
    paths.clientState('leaver'),
    'consents/leaver',
    paths.termination('leaver'),
  ])
    expect((await db.doc(path).get()).exists).toBe(false);
  expect((await db.doc('captures/leaver-open').get()).data()).toMatchObject({
    username: null,
    caption: null,
  });
  expect((await db.doc('approvals/leaver-stale').get()).data()).toMatchObject({
    username: '',
    caption: '',
  });
  expect(photos.objects.has('pending/leaver-open/image')).toBe(false);
  expect(photos.objects.has(image(unpublished))).toBe(false);
  // Retention exceptions remain pending G-SAFETY; nothing here sets a period.
  expect(photos.objects.has('review/leaver-held/image')).toBe(true);
  expect(
    await Promise.all(['reports', 'blocks', 'reviewQueue'].map(documents)),
  ).toEqual(retained);
  expect(principals.deleted).toEqual(['leaver']);

  await expect(backend.getDayState('leaver')).rejects.toThrow(
    'permission-denied',
  );
  await expect(backend.syncBoardView('leaver', s.merged)).rejects.toThrow(
    'permission-denied',
  );
  const captures = new CaptureService(
    db,
    {
      has: async () => false,
      save: async () => undefined,
      remove: (path) => photos.remove(path),
      process: () => Promise.reject(new Error('Not reached')),
    },
    'test',
    () => NOW,
  );
  await expect(captures.begin('leaver')).rejects.toThrow('permission-denied');
  expect((await backend.getDayState('friend')).photoState).toBe('ready');
});

test('only the caller’s own subject ends; malformed requests and suspended subjects change nothing', async () => {
  const s = await scenario();
  for (const input of [
    {},
    { confirm: false },
    { confirm: true, uid: 'friend' },
  ])
    await expect(service.end('leaver', input)).rejects.toThrow();
  await safety.setSubjectStatus('friend', 'suspended');
  await expect(service.end('friend', { confirm: true })).rejects.toThrow(
    'permission-denied',
  );
  expect((await db.doc(paths.subject('leaver')).get()).get('status')).toBe(
    'active',
  );
  expect((await db.doc(paths.subject('friend')).get()).get('status')).toBe(
    'suspended',
  );
  expect((await db.collection('accountTerminations').get()).empty).toBe(true);
  expect((await db.collection('deletionJobs').get()).empty).toBe(true);
  expect(photos.objects.has(image(s.a.pieceId))).toBe(true);
  expect(principals.deleted).toEqual([]);
});

test('a lost response and concurrent retries converge on one ended subject', async () => {
  const s = await scenario();
  const results = await Promise.all([
    service.end('leaver', { confirm: true }),
    service.end('leaver', { confirm: true }),
  ]);
  expect(results).toEqual([{ status: 'ended' }, { status: 'ended' }]);
  const epoch = (await db.doc(paths.subject('leaver')).get()).get(
    'accessEpoch',
  ) as unknown;
  expect(await service.end('leaver', { confirm: true })).toEqual({
    status: 'ended',
  });
  expect((await db.doc(paths.subject('leaver')).get()).get('accessEpoch')).toBe(
    epoch,
  );
  expect((await db.doc(paths.termination('leaver')).get()).exists).toBe(false);
  expect((await db.doc(paths.piece(s.a.pieceId)).get()).get('status')).toBe(
    'deleted',
  );
  expect(new Set(principals.deleted)).toEqual(new Set(['leaver']));
});

test('storage and Auth outages leave the subject closed and a private job that the scheduler resumes once', async () => {
  const s = await scenario();
  photos.failRemoval = true;
  principals.fail = true;
  expect(await service.end('leaver', { confirm: true })).toEqual({
    status: 'ended',
  });
  expect(
    (await db.doc(paths.termination('leaver')).get()).data(),
  ).toMatchObject({ status: 'pending', attemptCount: 1, leaseUntilMs: 0 });
  // Access is already closed even though physical removal has not happened.
  expect((await db.doc(paths.media(s.a.pieceId)).get()).get('visible')).toBe(
    false,
  );
  expect(photos.objects.has(image(s.a.pieceId))).toBe(true);
  await expect(backend.getDayState('leaver')).rejects.toThrow(
    'permission-denied',
  );
  photos.failRemoval = false;
  principals.fail = false;
  await Promise.all([service.resume(), service.resume()]);
  expect(principals.deleted).toEqual(['leaver']);
  expect((await db.doc(paths.termination('leaver')).get()).exists).toBe(false);
  await new PhotoDeletionService(db, photos).cleanup();
  expect(photos.objects.has(image(s.a.pieceId))).toBe(false);
  expect(photos.objects.has(image(s.past.pieceId))).toBe(false);
});

test('ending racing a FIT confirmation never leaves a visible photo or a FIT by the ended subject', async () => {
  const a = await seedBoard('end-race-a', 1, OUT, DAY, ['leaver']);
  const b = await seedBoard('end-race-b', 1, IN, DAY, ['friend']);
  await session('end-race', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'end-race');
  const results = await Promise.allSettled([
    service.end('leaver', { confirm: true }),
    backend.confirmFit(b.uid, 'end-race'),
  ]);
  expect(results[0]?.status).toBe('fulfilled');
  const day = await backend.getDayState('friend');
  const view = await backend.syncBoardView('friend', day.boardId!);
  expect(
    view.pieces.find((p) => p.id === a.pieceId)?.visibility ?? 'blank',
  ).toBe('blank');
  await expect(backend.confirmFit('leaver', 'end-race')).rejects.toThrow();
  expect(await subtree('views', 'leaver')).toBe(0);
  expect((await db.doc(paths.clientState('leaver')).get()).exists).toBe(false);
});

test('later growth by others keeps the blank piece without recreating the ended subject’s client data', async () => {
  const a = await seedBoard('end-grow-a', 1, OUT, DAY, ['leaver']);
  const b = await seedBoard('end-grow-b', 1, IN, DAY, ['friend']);
  const c = await seedBoard('end-grow-c', 1, OUT, DAY, ['third']);
  await merge('end-grow-1', a.uid, b.uid);
  await service.end('leaver', { confirm: true });
  const grown = await merge('end-grow-2', b.uid, c.uid);
  const board = await db.doc(paths.board(grown)).get();
  expect(
    (board.get('members') as { uid: string }[]).map((m) => m.uid).sort(),
  ).toEqual(['friend', 'leaver', 'third']);
  for (const uid of ['friend', 'third'])
    expect(
      (await backend.syncBoardView(uid, grown)).pieces.find(
        (p) => p.id === a.pieceId,
      )?.visibility,
    ).toBe('blank');
  for (const root of ['views', 'viewGrants'])
    expect(await subtree(root, 'leaver')).toBe(0);
  expect((await db.doc(paths.clientState('leaver')).get()).exists).toBe(false);
  expect((await db.doc(paths.daily(DAY, 'leaver')).get()).get('boardId')).toBe(
    grown,
  );
});

test('the Auth adapter deletes the anonymous principal and tolerates a repeated deletion', () => {
  // firebase-admin/auth cannot load inside Jest's CommonJS runtime; use the built adapter.
  const script = `
    const assert = require('node:assert/strict');
    const { initializeApp } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const { FirebasePrincipals } = require(${JSON.stringify(
      resolve('apps/functions/dist/services/account-termination.js'),
    )});
    (async () => {
      const auth = getAuth(initializeApp({ projectId: '${PROJECT}' }));
      const uid = 'synthetic-' + require('node:crypto').randomUUID();
      await auth.createUser({ uid });
      const adapter = new FirebasePrincipals(auth);
      await adapter.delete(uid);
      await assert.rejects(auth.getUser(uid), { code: 'auth/user-not-found' });
      await adapter.delete(uid);
    })().catch(() => process.exitCode = 1);
  `;
  expect(() =>
    execFileSync(process.execPath, ['-e', script], { timeout: 30000 }),
  ).not.toThrow();
});
