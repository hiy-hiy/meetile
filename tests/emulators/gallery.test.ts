import { paths } from '../../apps/functions/src/repositories/paths';
import { db, reset, backend, safety, seedBoard, OUT, DAY } from './helpers';

beforeEach(reset);

test('lists only the caller’s finished, still-active boards, newest first', async () => {
  const older = await seedBoard('gallery-older', 2, OUT, '2026-10-08', [
    'gallery-user',
  ]);
  const newer = await seedBoard('gallery-newer', 2, OUT, '2026-10-09', [
    'gallery-user',
  ]);
  await seedBoard('gallery-today', 1, OUT, DAY, ['gallery-user']);
  await seedBoard('gallery-other', 1, OUT, '2026-10-09', ['someone-else']);
  // A merged-away board keeps a stale view document but loses its grant.
  const retired = await seedBoard('gallery-retired', 1, OUT, '2026-10-07', [
    'gallery-user',
  ]);
  await db.doc(paths.board(retired.boardId)).update({ status: 'retired' });
  await db
    .doc(paths.grant('gallery-user', retired.boardId))
    .update({ active: false });
  // A view document alone is never proof of membership.
  const foreign = await seedBoard('gallery-foreign', 1, OUT, '2026-10-06', [
    'not-the-caller',
  ]);
  await db.doc(paths.view('gallery-user', foreign.boardId)).set({
    dayKey: '2026-10-06',
  });
  await db
    .doc(paths.grant('gallery-user', foreign.boardId))
    .set({ active: true, accessEpoch: 0 });

  expect(await backend.listGallery('gallery-user')).toEqual({
    entries: [
      { boardId: newer.boardId, dayKey: '2026-10-09' },
      { boardId: older.boardId, dayKey: '2026-10-08' },
    ],
  });
  // The listed board is synced through the existing per-viewer projection.
  const view = await backend.syncBoardView('gallery-user', older.boardId);
  expect(view).toMatchObject({ boardId: older.boardId, dayKey: '2026-10-08' });
  expect(JSON.stringify(await backend.listGallery('gallery-user'))).not.toMatch(
    /someone-else|not-the-caller|gallery-user-1/,
  );
});

test('a new participant has an empty gallery and inactive callers are refused', async () => {
  await backend.getDayState('gallery-new');
  expect(await backend.listGallery('gallery-new')).toEqual({ entries: [] });
  await expect(backend.listGallery('never-seen')).rejects.toThrow(
    'permission-denied',
  );
  await seedBoard('gallery-stop', 1, OUT, '2026-10-09', ['gallery-stopped']);
  await safety.setSubjectStatus('gallery-stopped', 'suspended');
  await expect(backend.listGallery('gallery-stopped')).rejects.toThrow(
    'permission-denied',
  );
});

test('deleting a photo after the day ended blanks it in the synced gallery view', async () => {
  const board = await seedBoard('gallery-blank', 2, OUT, '2026-10-09');
  const [owner, viewer] = board.members;
  if (!owner || !viewer) throw new Error('Missing artificial members');
  await db.doc(paths.piece(owner.pieceId)).update({ status: 'deleted' });
  expect((await backend.listGallery(viewer.uid)).entries).toEqual([
    { boardId: board.boardId, dayKey: '2026-10-09' },
  ]);
  const view = await backend.syncBoardView(viewer.uid, board.boardId);
  expect(view.pieces.find((p) => p.id === owner.pieceId)).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
});
