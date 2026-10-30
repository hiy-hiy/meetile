import { Backend } from '../../apps/functions/src/services/backend';
import { paths } from '../../apps/functions/src/repositories/paths';
import {
  db,
  reset,
  backend,
  safety,
  seedBoard,
  session,
  NOW,
  DAY,
  IN,
} from './helpers';

beforeEach(reset);

test('only an active participant can block the private owner of another piece', async () => {
  const all = await seedBoard('block-auth', 2);
  const [a, b] = all.members;
  if (!a || !b) throw new Error('Missing artificial members');
  await backend.getDayState('outsider');
  for (const [uid, input] of [
    ['outsider', { pieceId: b.pieceId }],
    [a.uid, { pieceId: a.pieceId }],
    [a.uid, { pieceId: 'unknown' }],
    [a.uid, { pieceId: b.pieceId, ownerUid: b.uid }],
  ] as const)
    await expect(safety.blockPhoto(uid, input)).rejects.toThrow();
  await safety.setSubjectStatus(a.uid, 'suspended');
  await expect(
    safety.blockPhoto(a.uid, { pieceId: b.pieceId }),
  ).rejects.toThrow('permission-denied');
  expect((await db.collection('blocks').get()).empty).toBe(true);
});

test('blocking has a generic receipt, invalidates both parties atomically, and leaves geometry and third-party content intact', async () => {
  const all = await seedBoard('block-both', 3);
  const [a, b, c] = all.members;
  if (!a || !b || !c) throw new Error('Missing artificial members');
  const original = (await db.doc(paths.board(all.boardId)).get()).data();
  expect(await safety.blockPhoto(a.uid, { pieceId: b.pieceId })).toEqual({
    status: 'blocked',
  });
  for (const uid of [a.uid, b.uid])
    expect((await db.doc(paths.subject(uid)).get()).get('accessEpoch')).toBe(1);
  expect((await db.doc(paths.subject(c.uid)).get()).get('accessEpoch')).toBe(0);
  expect((await db.doc(paths.block(a.uid, b.uid)).get()).data()).toEqual({
    blocked: true,
  });
  const av = await backend.syncBoardView(a.uid, all.boardId);
  const bv = await backend.syncBoardView(b.uid, all.boardId);
  for (const [view, id] of [
    [av, b.pieceId],
    [bv, a.pieceId],
  ] as const)
    expect(view.pieces.find((p) => p.id === id)).toMatchObject({
      visibility: 'blank',
      photoRef: null,
      username: null,
      caption: null,
    });
  expect(av.pieces.find((p) => p.id === a.pieceId)?.visibility).toBe('visible');
  expect(bv.pieces.find((p) => p.id === b.pieceId)?.visibility).toBe('visible');
  expect(
    (await backend.syncBoardView(c.uid, all.boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
  expect((await db.doc(paths.board(all.boardId)).get()).data()).toEqual(
    original,
  );
  expect((await db.collection('reports').get()).empty).toBe(true);
  expect((await backend.getDayState(a.uid)).photoState).toBe('ready');
});

test('retries and opposite-direction requests remain one block and one epoch change per party', async () => {
  const all = await seedBoard('block-retry', 2);
  const [a, b] = all.members;
  if (!a || !b) throw new Error('Missing artificial members');
  await Promise.all([
    safety.blockPhoto(a.uid, { pieceId: b.pieceId }),
    safety.blockPhoto(a.uid, { pieceId: b.pieceId }),
    safety.blockPhoto(b.uid, { pieceId: a.pieceId }),
  ]);
  await safety.removeOwnPiece(b.uid, b.pieceId);
  expect(await safety.blockPhoto(a.uid, { pieceId: b.pieceId })).toEqual({
    status: 'blocked',
  });
  expect((await db.collection('blocks').get()).size).toBe(1);
  // Own deletion can independently invalidate epochs; retry itself must not.
  const epoch: unknown = (await db.doc(paths.subject(a.uid)).get()).get(
    'accessEpoch',
  );
  await safety.blockPhoto(a.uid, { pieceId: b.pieceId });
  expect((await db.doc(paths.subject(a.uid)).get()).get('accessEpoch')).toBe(
    epoch,
  );
});

test('a block from an older day applies to new daily pieces and still permits indirect membership', async () => {
  const all = await seedBoard('block-day', 2);
  const [a, b] = all.members;
  if (!a || !b) throw new Error('Missing artificial members');
  const nextDay = '2026-10-11';
  const next = await seedBoard('block-next', 2, IN, nextDay);
  const [na, nb] = next.members;
  if (!na || !nb) throw new Error('Missing artificial members');
  // Give the two existing private safety subjects new daily IDs, not new identities.
  const raw = (await db.doc(paths.board(next.boardId)).get()).data()!;
  const batch = db.batch();
  const members = [
    { ...na, uid: a.uid },
    { ...nb, uid: b.uid },
  ];
  batch.update(db.doc(paths.board(next.boardId)), { members });
  for (const m of members) {
    batch.update(db.doc(paths.piece(m.pieceId)), { ownerUid: m.uid });
    batch.set(db.doc(paths.daily(nextDay, m.uid)), {
      dayKey: nextDay,
      boardId: next.boardId,
      pieceId: m.pieceId,
      participantKey: m.participantKey,
    });
  }
  await batch.commit();
  // A persisted outbox may first reach the server after 04:00.
  expect(await safety.blockPhoto(a.uid, { pieceId: b.pieceId })).toEqual({
    status: 'blocked',
  });
  const nextBackend = new Backend(db, () => NOW + 86400000);
  const view = await nextBackend.syncBoardView(a.uid, next.boardId);
  expect(view.pieces.find((p) => p.id === nb.pieceId)?.visibility).toBe(
    'blank',
  );
  expect(
    (await db.doc(paths.board(next.boardId)).get()).get('geometry'),
  ).toEqual(raw.geometry);
  expect((await db.doc(paths.daily(nextDay, a.uid)).get()).get('boardId')).toBe(
    next.boardId,
  );
  expect(
    (await backend.syncBoardView(b.uid, all.boardId)).pieces.find(
      (p) => p.id === a.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect((await db.doc(paths.daily(DAY, b.uid)).get()).get('boardId')).toBe(
    all.boardId,
  );
});

test('later merges preserve the block without preventing shared puzzle growth', async () => {
  const all = await seedBoard('block-grow', 2);
  const [a, b] = all.members;
  if (!a || !b) throw new Error('Missing artificial members');
  await safety.blockPhoto(a.uid, { pieceId: b.pieceId });
  const other = await seedBoard('block-third', 1, IN);
  await session('block-grow-join', a.uid, other.uid);
  await backend.confirmFit(a.uid, 'block-grow-join');
  const result = await backend.confirmFit(other.uid, 'block-grow-join');
  expect(result.status).toBe('merged');
  const day = await backend.getDayState(a.uid);
  expect(
    (await backend.syncBoardView(a.uid, day.boardId!)).pieces.find(
      (p) => p.id === b.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect(
    (await backend.syncBoardView(b.uid, day.boardId!)).pieces.find(
      (p) => p.id === a.pieceId,
    )?.visibility,
  ).toBe('blank');
});
