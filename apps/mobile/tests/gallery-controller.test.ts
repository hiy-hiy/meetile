import type { BoardView } from '@puzzle-sns/contracts';
import { GalleryController } from '../src/gallery/controller';
import type { GalleryEntry, GalleryStore } from '../src/gallery/store';

const piece = (id: string, x: number, visible = true) => ({
  id,
  position: { x, y: 0 },
  edges: {
    north: 'round-out' as const,
    east: 'round-out' as const,
    south: 'round-out' as const,
    west: 'round-in' as const,
  },
  visibility: visible ? ('visible' as const) : ('blank' as const),
  photoRef: visible ? `normalized/${id}/image` : null,
  username: visible ? 'Synthetic name' : null,
  caption: visible ? 'Synthetic caption' : null,
});
const view = (boardId: string, dayKey: string, blank: string[] = []) =>
  ({
    boardId,
    dayKey,
    version: 1,
    pieces: [
      piece(`${boardId}-a`, 0, !blank.includes(`${boardId}-a`)),
      piece(`${boardId}-b`, 1, !blank.includes(`${boardId}-b`)),
    ],
  }) as BoardView;

/** Mirrors the SQLite store's file rules in memory. */
function memoryStore() {
  const rows = new Map<string, GalleryEntry>();
  const store: GalleryStore & { owner: string | null } = {
    owner: null,
    list: jest.fn(async () =>
      [...rows.values()].sort((a, b) =>
        b.view.dayKey.localeCompare(a.view.dayKey),
      ),
    ),
    save: jest.fn(async (value: BoardView, sources: Record<string, string>) => {
      const previous = rows.get(value.boardId)?.uris ?? {};
      const uris: Record<string, string> = {};
      for (const p of value.pieces) {
        if (p.visibility !== 'visible') continue;
        const uri = sources[p.id] ? `stored:${p.id}` : previous[p.id];
        if (uri) uris[p.id] = uri;
      }
      rows.set(value.boardId, { view: value, uris });
    }),
    claim: jest.fn(async (owner: string) => {
      if (store.owner !== owner) rows.clear();
      store.owner = owner;
    }),
    close: jest.fn(async () => {}),
  };
  return { store, rows };
}
function setup(
  views: Record<string, BoardView>,
  list = Object.values(views).map((v) => ({
    boardId: v.boardId,
    dayKey: v.dayKey,
  })),
) {
  const release = jest.fn();
  const port = {
    call: jest.fn(async (name: string, data: unknown): Promise<unknown> => {
      if (name === 'listGallery') return { entries: list };
      if (name === 'syncBoardView') {
        const { boardId } = data as { boardId: string };
        const value = views[boardId];
        if (!value) throw new Error('permission-denied');
        return value;
      }
      throw new Error(`unexpected ${name}`);
    }),
    loadImages: jest.fn(async (board: BoardView) => ({
      uris: Object.fromEntries(
        board.pieces
          .filter((p) => p.visibility === 'visible')
          .map((p) => [p.id, `cache:${p.id}`]),
      ),
      release,
    })),
  };
  const { store, rows } = memoryStore();
  let owner: string | null = 'owner-hash';
  const gallery = new GalleryController(port, store, async () => owner);
  return {
    gallery,
    port,
    store,
    rows,
    release,
    views,
    setOwner: (value: string | null) => {
      owner = value;
    },
  };
}

test('syncs the listed finished boards into the device store, newest first', async () => {
  const t = setup({
    old: view('old', '2026-10-28'),
    new: view('new', '2026-10-29'),
  });
  await t.gallery.sync();
  expect(t.store.claim).toHaveBeenCalledWith('owner-hash');
  expect(t.port.call).toHaveBeenCalledWith('syncBoardView', { boardId: 'old' });
  expect(t.release).toHaveBeenCalledTimes(2);
  const state = t.gallery.snapshot();
  expect(state.status).toBe('ready');
  expect(state.entries.map((e) => e.view.dayKey)).toEqual([
    '2026-10-29',
    '2026-10-28',
  ]);
  expect(state.entries[0]?.uris).toEqual({
    'new-a': 'stored:new-a',
    'new-b': 'stored:new-b',
  });
});

test('a photo deleted while offline is blanked on the next connection even if images fail', async () => {
  const t = setup({ day: view('day', '2026-10-29') });
  await t.gallery.sync();
  t.views.day = view('day', '2026-10-29', ['day-a']);
  t.port.loadImages.mockRejectedValueOnce(new Error('offline images'));
  await t.gallery.sync();
  expect(t.gallery.snapshot().entries[0]?.uris).toEqual({
    'day-b': 'stored:day-b',
  });
  expect(t.gallery.snapshot().entries[0]?.view.pieces[0]).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
});

test('offline, the stored gallery stays readable and nothing is removed', async () => {
  const t = setup({ day: view('day', '2026-10-29') });
  await t.gallery.sync();
  t.port.call.mockRejectedValue(new Error('network'));
  await t.gallery.sync();
  expect(t.gallery.snapshot().status).toBe('offline');
  expect(t.gallery.snapshot().entries).toHaveLength(1);
  // Without a known identity, the server is not asked and the store is not claimed.
  t.setOwner(null);
  t.port.call.mockClear();
  await t.gallery.sync();
  expect(t.port.call).not.toHaveBeenCalled();
  expect(t.gallery.snapshot().entries).toHaveLength(1);
});

test('a different identity wipes the previous gallery before syncing', async () => {
  const t = setup({ day: view('day', '2026-10-29') });
  await t.gallery.sync();
  t.setOwner('after-local-reset');
  t.port.call.mockImplementation(async (name: string) =>
    name === 'listGallery' ? { entries: [] } : null,
  );
  await t.gallery.sync();
  expect(t.gallery.snapshot().entries).toEqual([]);
});

test('a mismatched or refused board keeps the stored copy and other boards still sync', async () => {
  const t = setup({ a: view('a', '2026-10-27'), b: view('b', '2026-10-28') }, [
    { boardId: 'a', dayKey: '2026-10-26' },
    { boardId: 'b', dayKey: '2026-10-28' },
    { boardId: 'gone', dayKey: '2026-10-25' },
  ]);
  await t.gallery.sync();
  expect(t.gallery.snapshot().entries.map((e) => e.view.boardId)).toEqual([
    'b',
  ]);
});

test('locally hidden pieces are masked before download and storage; syncs do not overlap', async () => {
  const t = setup({ day: view('day', '2026-10-29') });
  const masked = new GalleryController(
    t.port,
    t.store,
    async () => 'owner-hash',
    (value) => ({
      ...value,
      pieces: value.pieces.map((p) =>
        p.id === 'day-b'
          ? {
              ...p,
              visibility: 'blank',
              photoRef: null,
              username: null,
              caption: null,
            }
          : p,
      ),
    }),
  );
  const first = masked.sync();
  const second = masked.sync();
  expect(second).toBe(first);
  await first;
  expect(t.port.call).toHaveBeenCalledTimes(2);
  const loaded = t.port.loadImages.mock.calls[0]?.[0];
  expect(loaded?.pieces[1]?.visibility).toBe('blank');
  expect(masked.snapshot().entries[0]?.uris).toEqual({
    'day-a': 'stored:day-a',
  });
});
