import { ReportingService } from '../../apps/functions/src/services/reporting';
import { SafetyFoundation } from '../../apps/functions/src/services/safety';
import { paths } from '../../apps/functions/src/repositories/paths';
import {
  db,
  reset,
  backend,
  seedBoard,
  session,
  NOW,
  DAY,
  OUT,
  IN,
} from './helpers';

const reports = new ReportingService(db, () => NOW);
beforeEach(reset);
async function shared() {
  const a = await seedBoard('report-a', 1, OUT);
  const b = await seedBoard('report-b', 1, IN);
  await session('report-join', a.uid, b.uid);
  await backend.confirmFit(a.uid, 'report-join');
  const result = await backend.confirmFit(b.uid, 'report-join');
  if (result.status !== 'merged') throw new Error('Synthetic merge failed');
  return { a, b, boardId: result.boardId };
}
test('a nonparticipant, self-report and forged safety identity cannot enqueue or hide anything', async () => {
  const { a, b } = await shared();
  await backend.getDayState('stranger');
  await expect(
    reports.report('stranger', { pieceId: b.pieceId, reason: 'other' }),
  ).rejects.toThrow('permission-denied');
  await expect(
    reports.report(a.uid, { pieceId: a.pieceId, reason: 'other' }),
  ).rejects.toThrow('permission-denied');
  await expect(
    reports.report(a.uid, {
      pieceId: b.pieceId,
      reason: 'other',
      reporterUid: b.uid,
    }),
  ).rejects.toThrow();
  expect((await db.collection('reports').get()).empty).toBe(true);
  expect((await db.doc(paths.hidden(a.uid, b.pieceId)).get()).exists).toBe(
    false,
  );
});
test('the report and reporter-only hide commit together; geometry and everyone else’s view remain unchanged', async () => {
  const { a, b, boardId } = await shared();
  const before = (await db.doc(paths.board(boardId)).get()).data();
  expect(
    await reports.report(a.uid, { pieceId: b.pieceId, reason: 'harassment' }),
  ).toEqual({ status: 'reported' });
  const queued = await db.doc(paths.report(a.uid, b.pieceId)).get();
  expect(queued.data()).toEqual({
    reporterUid: a.uid,
    pieceId: b.pieceId,
    dayKey: DAY,
    reason: 'harassment',
    status: 'pending',
    createdAtMs: NOW,
  });
  const own = await backend.syncBoardView(a.uid, boardId);
  expect(own.pieces.find((p) => p.id === b.pieceId)).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
  expect(own.pieces.find((p) => p.id === a.pieceId)?.visibility).toBe(
    'visible',
  );
  expect(
    (await backend.syncBoardView(b.uid, boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
  expect((await db.doc(paths.board(boardId)).get()).data()).toEqual(before);
  expect((await db.doc(paths.piece(b.pieceId)).get()).get('status')).toBe(
    'approved',
  );
  expect(
    (await db.doc(paths.media(b.pieceId)).get()).get('epochs'),
  ).not.toHaveProperty(a.uid);
  expect((await backend.getDayState(a.uid)).photoState).toBe('ready');
});
test('simultaneous retries create one immutable queue entry and one access invalidation', async () => {
  const { a, b } = await shared();
  const before = (await db.doc(paths.subject(a.uid)).get()).get(
    'accessEpoch',
  ) as number;
  const input = { pieceId: b.pieceId, reason: 'other' };
  await Promise.all([
    reports.report(a.uid, input),
    reports.report(a.uid, input),
    reports.report(a.uid, input),
  ]);
  await reports.report(a.uid, { ...input, reason: 'violence' });
  expect((await db.collection('reports').get()).size).toBe(1);
  expect(
    (await db.doc(paths.report(a.uid, b.pieceId)).get()).get('reason'),
  ).toBe('other');
  expect((await db.doc(paths.subject(a.uid)).get()).get('accessEpoch')).toBe(
    before + 1,
  );
});
test('different reporters stay private and one report does not hide the target for another viewer', async () => {
  const all = await seedBoard('three', 3);
  const [a, b, c] = all.members;
  if (!a || !b || !c) throw new Error('Bad artificial board');
  await reports.report(a.uid, { pieceId: c.pieceId, reason: 'personal-info' });
  expect(
    (await backend.syncBoardView(b.uid, all.boardId)).pieces.find(
      (p) => p.id === c.pieceId,
    )?.visibility,
  ).toBe('visible');
  await reports.report(b.uid, { pieceId: c.pieceId, reason: 'sexual' });
  expect((await db.collection('reports').get()).size).toBe(2);
  expect(
    (await backend.syncBoardView(c.uid, all.boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
});
test('accepted report retries survive later target deletion and do not recreate text or publish evidence', async () => {
  const { a, b, boardId } = await shared();
  const input = { pieceId: b.pieceId, reason: 'other' };
  await reports.report(a.uid, input);
  await new SafetyFoundation(db).removeOwnPiece(b.uid, b.pieceId);
  expect(await reports.report(a.uid, input)).toEqual({ status: 'reported' });
  expect(
    (await backend.syncBoardView(a.uid, boardId)).pieces.find(
      (p) => p.id === b.pieceId,
    )?.caption,
  ).toBeNull();
  expect((await db.collection('reports').get()).size).toBe(1);
  expect(
    Object.keys((await db.doc(paths.report(a.uid, b.pieceId)).get()).data()!),
  ).not.toContain('caption');
});
test('all existing historical copies for the reporter are scrubbed and hidden state survives later merges', async () => {
  const { a, b, boardId } = await shared();
  const c = await seedBoard('later', 1, IN);
  await reports.report(a.uid, { pieceId: b.pieceId, reason: 'other' });
  expect(
    (await db.doc(paths.view(a.uid, boardId)).get()).get('pieces'),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: b.pieceId,
        visibility: 'blank',
        username: null,
        caption: null,
      }),
    ]),
  );
  await session('later', a.uid, c.uid);
  await backend.confirmFit(a.uid, 'later');
  expect((await backend.confirmFit(c.uid, 'later')).status).toBe('merged');
  const day = await backend.getDayState(a.uid);
  const view = await backend.syncBoardView(a.uid, day.boardId!);
  expect(view.pieces.find((p) => p.id === b.pieceId)?.visibility).toBe('blank');
});
test('suspended reporters cannot write a queue entry', async () => {
  const { a, b } = await shared();
  await new SafetyFoundation(db).setSubjectStatus(a.uid, 'suspended');
  await expect(
    reports.report(a.uid, { pieceId: b.pieceId, reason: 'other' }),
  ).rejects.toThrow('permission-denied');
  expect((await db.collection('reports').get()).empty).toBe(true);
});
