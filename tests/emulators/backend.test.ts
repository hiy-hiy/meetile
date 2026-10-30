import { Backend } from '../../apps/functions/src/services/backend';
import { Firestore } from 'firebase-admin/firestore';
import {
  boardSchema,
  pieceSchema,
} from '../../apps/functions/src/domain/models';
import { paths } from '../../apps/functions/src/repositories/paths';
import {
  backend,
  db,
  reset,
  seedBoard,
  session,
  safety,
  NOW,
  DAY,
  IN,
} from './helpers';

beforeEach(reset);

test('development data does not appear in staging or production emulator namespaces', async () => {
  const a = await seedBoard('isolated');
  expect((await db.doc(paths.board(a.boardId)).get()).exists).toBe(true);
  for (const projectId of [
    'demo-puzzle-sns-staging',
    'demo-puzzle-sns-production',
  ]) {
    const isolated = new Firestore({
      projectId,
      host: '127.0.0.1:8080',
      ssl: false,
    });
    try {
      expect((await isolated.doc(paths.board(a.boardId)).get()).exists).toBe(
        false,
      );
      await expect(
        new Backend(isolated, () => NOW).syncBoardView(a.uid, a.boardId),
      ).rejects.toThrow('failed-precondition');
    } finally {
      await isolated.terminate();
    }
  }
});

test('server publication requires approval and is atomic, one per day, and retryable', async () => {
  const uid = 'publisher';
  expect(await backend.getDayState(uid)).toMatchObject({
    dayKey: DAY,
    photoState: 'not-created',
  });
  const approval = {
    ownerUid: uid,
    dayKey: DAY,
    status: 'approved',
    normalizedPieceId: 'synthetic-image',
    username: '',
    caption: '',
  };
  await db.doc(paths.approval('approval')).set(approval);
  const [first, second] = await Promise.all([
    backend.publishApprovedPiece('approval'),
    backend.publishApprovedPiece('approval'),
  ]);
  expect(first).toEqual(second);
  const board = boardSchema.parse(
    (await db.doc(paths.board(first.boardId)).get()).data(),
  );
  expect(board.geometry.pieces).toHaveLength(1);
  expect(await backend.getDayState(uid)).toMatchObject({
    photoState: 'ready',
    ownPieceId: first.pieceId,
  });
  await db
    .doc(paths.approval('other'))
    .set({ ...approval, normalizedPieceId: 'other-image' });
  await expect(backend.publishApprovedPiece('other')).rejects.toThrow(
    'failed-precondition',
  );
  await safety.removePiece(first.pieceId);
  await expect(backend.publishApprovedPiece('other')).rejects.toThrow(
    'failed-precondition',
  );
  expect(await backend.getDayState(uid)).toMatchObject({
    photoState: 'unavailable',
  });
});

test.each(['held', 'rejected', 'wrong-day'])(
  'never publishes an unapproved or expired photo: %s',
  async (status) => {
    await backend.getDayState('u');
    await db.doc(paths.approval('approval')).set({
      ownerUid: 'u',
      dayKey: status === 'wrong-day' ? '2026-10-09' : DAY,
      status: status === 'wrong-day' ? 'approved' : status,
      normalizedPieceId: 'image',
      username: '',
      caption: '',
    });
    await expect(backend.publishApprovedPiece('approval')).rejects.toThrow(
      'failed-precondition',
    );
    expect((await db.collection('pieces').get()).empty).toBe(true);
  },
);

test('both confirmations are required; concurrent retries produce one canonical merge', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  await session('fit', a.uid, b.uid);
  expect(await backend.confirmFit(a.uid, 'fit')).toEqual({ status: 'waiting' });
  const [first, retry] = await Promise.all([
    backend.confirmFit(b.uid, 'fit'),
    backend.confirmFit(b.uid, 'fit'),
  ]);
  expect(first).toEqual(retry);
  expect(first.status).toBe('merged');
  if (first.status !== 'merged') throw new Error('Expected merge');
  const board = boardSchema.parse(
    (await db.doc(paths.board(first.boardId)).get()).data(),
  );
  expect(board.geometry.pieces).toHaveLength(2);
  expect(board.version).toBe(2);
  const aState = await backend.getDayState(a.uid);
  const bState = await backend.getDayState(b.uid);
  expect(aState.boardId).toBe(bState.boardId);
  const view = await backend.syncBoardView(a.uid, first.boardId);
  expect(view.pieces).toHaveLength(2);
  expect(JSON.stringify(view)).not.toContain(a.uid);
  expect(JSON.stringify(view)).not.toContain(b.uid);
  expect(JSON.stringify(view)).not.toContain('participantKey');
  await expect(
    backend.syncBoardView('outsider', first.boardId),
  ).rejects.toThrow();
  await expect(backend.syncBoardView(a.uid, a.boardId)).rejects.toThrow(
    'permission-denied',
  );
});

test('two FITs sharing one board rebase on latest membership without splitting', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const c = await seedBoard('c', 1, IN);
  await session('ab', a.uid, b.uid);
  await session('ac', a.uid, c.uid);
  await backend.confirmFit(b.uid, 'ab');
  await backend.confirmFit(c.uid, 'ac');
  const outcomes = await Promise.all([
    backend.confirmFit(a.uid, 'ab'),
    backend.confirmFit(a.uid, 'ac'),
  ]);
  expect(outcomes.every((value) => value.status === 'merged')).toBe(true);
  const states = await Promise.all(
    [a.uid, b.uid, c.uid].map((uid) => backend.getDayState(uid)),
  );
  expect(new Set(states.map((value) => value.boardId)).size).toBe(1);
  const id = states[0]?.boardId;
  if (!id) throw new Error('Missing merged board');
  expect(
    boardSchema.parse((await db.doc(paths.board(id)).get()).data()).geometry
      .pieces,
  ).toHaveLength(3);
  expect(
    (await db.collection('boards').where('status', '==', 'active').get()).size,
  ).toBe(1);
});

test('concurrent last-slot FIT accepts exactly twenty pieces and leaves the loser unchanged', async () => {
  const a = await seedBoard('a', 19);
  const b = await seedBoard('b', 1, IN);
  const c = await seedBoard('c', 1, IN);
  await session('ab', a.uid, b.uid);
  await session('ac', a.uid, c.uid);
  await backend.confirmFit(b.uid, 'ab');
  await backend.confirmFit(c.uid, 'ac');
  const outcomes = await Promise.all([
    backend.confirmFit(a.uid, 'ab'),
    backend.confirmFit(a.uid, 'ac'),
  ]);
  expect(outcomes.filter((value) => value.status === 'merged')).toHaveLength(1);
  expect(outcomes).toContainEqual({
    status: 'not-merged',
    reason: 'piece-limit',
  });
  const boards = await db
    .collection('boards')
    .where('status', '==', 'active')
    .get();
  expect(
    boards.docs
      .map((doc) => boardSchema.parse(doc.data()).geometry.pieces.length)
      .sort((x, y) => x - y),
  ).toEqual([1, 20]);
});

test('no-placement leaves geometry and membership unchanged and discloses no opposing board', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b');
  const before = (await db.doc(paths.board(a.boardId)).get()).data();
  await session('ab', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'ab');
  expect(await backend.confirmFit(b.uid, 'ab')).toEqual({
    status: 'not-merged',
    reason: 'no-placement',
  });
  expect((await db.doc(paths.board(a.boardId)).get()).data()).toEqual(before);
  expect((await backend.getDayState(a.uid)).boardId).toBe(a.boardId);
});

test('unknown participants, forged readiness, expiry and 4am crossing cannot mutate a board', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  await session('ab', a.uid, b.uid);
  await expect(backend.confirmFit('outsider', 'ab')).rejects.toThrow(
    'permission-denied',
  );
  await db.doc(paths.session('ab')).update({ mutualDetectionVerified: false });
  await expect(backend.confirmFit(a.uid, 'ab')).rejects.toThrow(
    'failed-precondition',
  );
  await db.doc(paths.session('ab')).update({ mutualDetectionVerified: true });
  const expired = new Backend(db, () => NOW + 30000);
  await expect(expired.confirmFit(a.uid, 'ab')).rejects.toThrow(
    'failed-precondition',
  );
  const tomorrow = new Backend(db, () => Date.parse('2026-10-10T19:00:00Z'));
  await expect(tomorrow.confirmFit(a.uid, 'ab')).rejects.toThrow(
    'failed-precondition',
  );
  expect(await tomorrow.getDayState(a.uid)).toMatchObject({
    dayKey: '2026-10-11',
    photoState: 'not-created',
    ownPieceId: null,
  });
  expect((await db.collection('boards').get()).size).toBe(2);
});

test('suspended or deleted actors cannot FIT; other participants can continue with blank geometry', async () => {
  const a = await seedBoard('a', 2);
  const b = await seedBoard('b', 1, IN);
  await session('ab', a.uid, b.uid);
  await safety.removePiece(a.pieceId);
  await expect(backend.confirmFit(a.uid, 'ab')).rejects.toThrow(
    'failed-precondition',
  );
  const other = a.members[1];
  if (!other) throw new Error('Missing member');
  await session('other-b', other.uid, b.uid);
  await backend.confirmFit(other.uid, 'other-b');
  const result = await backend.confirmFit(b.uid, 'other-b');
  if (result.status !== 'merged') throw new Error('Expected continued growth');
  expect(
    (await backend.syncBoardView(other.uid, result.boardId)).pieces.find(
      (p) => p.id === a.pieceId,
    ),
  ).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
  await safety.setSubjectStatus(other.uid, 'suspended');
  await expect(backend.getDayState(other.uid)).rejects.toThrow(
    'permission-denied',
  );
  expect(
    pieceSchema.parse((await db.doc(paths.piece(a.pieceId)).get()).data())
      .status,
  ).toBe('deleted');
});

test('safety blocking is symmetric, persists across days, and still allows indirect board membership', async () => {
  const a = await seedBoard('a', 2);
  const b = await seedBoard('b', 1, IN);
  await safety.block(a.uid, b.uid);
  const other = a.members[1];
  if (!other) throw new Error('Missing member');
  await session('ab', other.uid, b.uid);
  await backend.confirmFit(other.uid, 'ab');
  const result = await backend.confirmFit(b.uid, 'ab');
  if (result.status !== 'merged') throw new Error('Expected merge');
  expect(
    (await backend.syncBoardView(a.uid, result.boardId)).pieces.find(
      (p) => p.id === b.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect(
    (await backend.syncBoardView(b.uid, result.boardId)).pieces.find(
      (p) => p.id === a.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect(
    (await backend.syncBoardView(other.uid, result.boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
  const old = await seedBoard('historical', 1, IN, '2026-10-09');
  await db.doc(paths.block(a.uid, old.uid)).set({ blocked: true });
  expect((await db.doc(paths.block(a.uid, b.uid)).get()).exists).toBe(true);
});

test('crossing 4am while reading a transaction aborts both photo publication and FIT confirmation', async () => {
  const before = Date.parse('2026-10-10T18:59:59.999Z');
  const after = before + 1;
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  await new Backend(db, () => before).createVerifiedSession(
    'boundary',
    [a.uid, b.uid],
    after,
  );
  let reads = 0;
  const crossing = new Backend(db, () => (reads++ === 0 ? before : after));
  await expect(crossing.confirmFit(a.uid, 'boundary')).rejects.toThrow(
    'failed-precondition',
  );
  expect(
    (await db.doc(paths.session('boundary')).get()).get('confirmed'),
  ).toEqual([]);
  await new Backend(db, () => before).confirmFit(a.uid, 'boundary');
  reads = 0;
  await expect(crossing.confirmFit(b.uid, 'boundary')).rejects.toThrow(
    'failed-precondition',
  );
  expect((await db.collection('boards').get()).size).toBe(2);
  await backend.getDayState('publisher');
  await db.doc(paths.approval('boundary-photo')).set({
    ownerUid: 'publisher',
    dayKey: DAY,
    status: 'approved',
    normalizedPieceId: 'boundary-photo',
    username: '',
    caption: '',
  });
  reads = 0;
  await expect(crossing.publishApprovedPiece('boundary-photo')).rejects.toThrow(
    'failed-precondition',
  );
  expect((await db.doc(paths.piece('boundary-photo')).get()).exists).toBe(
    false,
  );
});

test('deletion racing a FIT never restores the deleted photo or its image permissions', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  await session('ab', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'ab');
  const results = await Promise.allSettled([
    safety.removePiece(a.pieceId),
    backend.confirmFit(b.uid, 'ab'),
  ]);
  expect(results[0]?.status).toBe('fulfilled');
  expect((await db.doc(paths.media(a.pieceId)).get()).get('visible')).toBe(
    false,
  );
  const state = await backend.getDayState(b.uid);
  if (!state.boardId) throw new Error('Missing board');
  const view = await backend.syncBoardView(b.uid, state.boardId);
  const piece = view.pieces.find((p) => p.id === a.pieceId);
  if (piece)
    expect(piece).toMatchObject({
      visibility: 'blank',
      username: null,
      caption: null,
      photoRef: null,
    });
});

test('blocking racing a FIT preserves membership while blanking both directions', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  await session('ab', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'ab');
  const [, result] = await Promise.all([
    safety.block(a.uid, b.uid),
    backend.confirmFit(b.uid, 'ab'),
  ]);
  if (result.status !== 'merged') throw new Error('Expected merge');
  expect(
    (await backend.syncBoardView(a.uid, result.boardId)).pieces.find(
      (p) => p.id === b.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect(
    (await backend.syncBoardView(b.uid, result.boardId)).pieces.find(
      (p) => p.id === a.pieceId,
    )?.visibility,
  ).toBe('blank');
});
