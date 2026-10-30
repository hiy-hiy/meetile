import { PhotoDeletionService } from '../../apps/functions/src/services/photo-deletion';
import {
  CaptureService,
  type PhotoProcessor,
} from '../../apps/functions/src/services/capture';
import { Backend } from '../../apps/functions/src/services/backend';
import { paths } from '../../apps/functions/src/repositories/paths';
import {
  db,
  reset,
  backend,
  seedBoard,
  session,
  OUT,
  IN,
  NOW,
  DAY,
} from './helpers';

class ArtificialPhotos implements PhotoProcessor {
  objects = new Map<string, Buffer>();
  failRemoval = false;
  async has(path: string) {
    return this.objects.has(path);
  }
  async save(path: string, image: Buffer) {
    this.objects.set(path, image);
  }
  async remove(path: string) {
    if (this.failRemoval) throw new Error('Synthetic storage outage');
    this.objects.delete(path);
  }
  async process() {
    return {
      decision: 'approved' as const,
      image: Buffer.from('artificial image'),
    };
  }
}
let photos: ArtificialPhotos;
let deletion: PhotoDeletionService;
beforeEach(async () => {
  await reset();
  photos = new ArtificialPhotos();
  deletion = new PhotoDeletionService(db, photos);
});
async function publish() {
  await backend.getDayState('owner');
  const captures = new CaptureService(db, photos, 'test', () => NOW);
  await captures.acceptOnboarding('owner', {
    legalVersion: 'test',
    age16OrOlder: true,
    accepted: true,
  });
  const capture = await captures.begin('owner');
  await captures.upload('owner', {
    captureId: capture.captureId,
    base64: '/9j/2Q==',
  });
  await captures.submit('owner', {
    captureId: capture.captureId,
    username: '人工署名',
    caption: '人工図形',
  });
  const day = await backend.getDayState('owner');
  if (!day.ownPieceId || !day.boardId)
    throw new Error('Missing artificial piece');
  return { captures, capture, pieceId: day.ownPieceId, boardId: day.boardId };
}
test('only the owner can delete, with no canonical or image change on a forbidden request', async () => {
  const own = await publish();
  await backend.getDayState('stranger');
  await expect(deletion.removeOwn('stranger', own.pieceId)).rejects.toThrow(
    'permission-denied',
  );
  expect((await backend.getDayState('owner')).photoState).toBe('ready');
  expect(photos.objects.has(`normalized/${own.pieceId}/image`)).toBe(true);
  expect((await db.collection('deletionJobs').get()).empty).toBe(true);
});
test('deletion scrubs published and private copies, retains geometry and daily membership, and is idempotent', async () => {
  const own = await publish();
  const before = (await db.doc(paths.board(own.boardId)).get()).data();
  expect(await deletion.removeOwn('owner', own.pieceId)).toEqual({
    status: 'deleted',
  });
  expect((await db.doc(paths.board(own.boardId)).get()).data()).toEqual(before);
  expect(await backend.getDayState('owner')).toMatchObject({
    photoState: 'unavailable',
    ownPieceId: own.pieceId,
    boardId: own.boardId,
  });
  const view = await backend.syncBoardView('owner', own.boardId);
  expect(view.pieces[0]).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
  expect(
    (await db.doc(`captures/${own.capture.captureId}`).get()).data(),
  ).toMatchObject({ username: null, caption: null });
  expect(
    (await db.doc(paths.approval(own.capture.captureId)).get()).data(),
  ).toMatchObject({ username: '', caption: '' });
  expect(photos.objects.has(`normalized/${own.pieceId}/image`)).toBe(false);
  expect((await db.doc(paths.media(own.pieceId)).get()).data()).toEqual({
    visible: false,
    epochs: {},
  });
  await expect(own.captures.begin('owner')).rejects.toThrow();
  const epoch = (await db.doc(paths.subject('owner')).get()).get(
    'accessEpoch',
  ) as unknown;
  await deletion.removeOwn('owner', own.pieceId);
  expect((await db.doc(paths.subject('owner')).get()).get('accessEpoch')).toBe(
    epoch,
  );
  expect((await db.collection('pieces').get()).size).toBe(1);
});
test('all historical viewer copies are scrubbed while other pieces and board geometry remain intact', async () => {
  const a = await seedBoard('a', 1, OUT);
  const b = await seedBoard('b', 1, IN);
  await session('join', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'join');
  const merged = await backend.confirmFit(b.uid, 'join');
  expect(merged.status).toBe('merged');
  const before = (await db.collection('boards').get()).docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
  }));
  await deletion.removeOwn(a.uid, a.pieceId);
  for (const board of before) {
    expect((await db.doc(paths.board(board.id)).get()).data()).toEqual(
      board.data,
    );
    for (const member of board.data.members as { uid: string }[]) {
      const view = await db.doc(paths.view(member.uid, board.id)).get();
      const pieces = view.get('pieces') as {
        id: string;
        visibility: string;
        caption: string | null;
      }[];
      const target = pieces.find((p) => p.id === a.pieceId);
      if (target)
        expect(target).toMatchObject({
          visibility: 'blank',
          caption: null,
          photoRef: null,
          username: null,
        });
    }
  }
  if (merged.status !== 'merged') throw new Error('Bad synthetic merge');
  const view = await backend.syncBoardView(b.uid, merged.boardId);
  expect(view.pieces.find((p) => p.id === b.pieceId)?.visibility).toBe(
    'visible',
  );
  expect((await backend.getDayState(a.uid)).photoState).toBe('unavailable');
});
test('storage outage leaves an inaccessible image and retry job, then cleanup removes it', async () => {
  const own = await publish();
  photos.failRemoval = true;
  await deletion.removeOwn('owner', own.pieceId);
  expect((await backend.getDayState('owner')).photoState).toBe('unavailable');
  expect((await db.doc(paths.media(own.pieceId)).get()).get('visible')).toBe(
    false,
  );
  expect(
    (await db.doc(`deletionJobs/${own.pieceId}`).get()).get('attemptCount'),
  ).toBe(1);
  photos.failRemoval = false;
  await Promise.all([deletion.cleanup(), deletion.cleanup()]);
  expect(photos.objects.has(`normalized/${own.pieceId}/image`)).toBe(false);
  expect((await db.doc(`deletionJobs/${own.pieceId}`).get()).exists).toBe(
    false,
  );
});
test('a malformed private job cannot delete another piece’s image', async () => {
  const own = await publish();
  await db.doc(`deletionJobs/${own.pieceId}`).set({
    objectPath: 'normalized/another/image',
    status: 'pending',
    attemptCount: 0,
  });
  photos.objects.set('normalized/another/image', Buffer.from('synthetic only'));
  await deletion.cleanup();
  expect(photos.objects.has('normalized/another/image')).toBe(true);
  expect(photos.objects.has(`normalized/${own.pieceId}/image`)).toBe(true);
});
test('past-day deletion leaves the old geometry fixed and does not create another piece', async () => {
  const a = await seedBoard('old', 1, OUT);
  const before = (await db.doc(paths.board(a.boardId)).get()).data();
  await deletion.removeOwn(a.uid, a.pieceId);
  expect((await db.doc(paths.board(a.boardId)).get()).data()).toEqual(before);
  const nextDay = new Backend(db, () => NOW + 86400000);
  expect((await nextDay.getDayState(a.uid)).dayKey).not.toBe(DAY);
  expect((await nextDay.getDayState(a.uid)).photoState).toBe('not-created');
  expect(
    (await backend.syncBoardView(a.uid, a.boardId)).pieces[0]?.visibility,
  ).toBe('blank');
});
test('deletion racing a final FIT confirmation cannot restore a photo or mutate its geometry afterward', async () => {
  const a = await seedBoard('race-a', 1, OUT);
  const b = await seedBoard('race-b', 1, IN);
  await session('race', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'race');
  const results = await Promise.allSettled([
    deletion.removeOwn(a.uid, a.pieceId),
    backend.confirmFit(b.uid, 'race'),
  ]);
  expect(results[0]?.status).toBe('fulfilled');
  const day = await backend.getDayState(b.uid);
  const view = await backend.syncBoardView(b.uid, day.boardId!);
  expect(
    view.pieces.find((p) => p.id === a.pieceId)?.visibility ?? 'blank',
  ).toBe('blank');
  await expect(backend.confirmFit(a.uid, 'race')).rejects.toThrow();
});
