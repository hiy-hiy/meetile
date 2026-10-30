import { demoEntries, demoGallerySource } from '../src/local/gallery-demo/data';

const photos = Array.from(
  { length: 12 },
  (_, index) => `file:///artificial-${index}.jpg`,
);
test('six distinct connected silhouettes use unique images per day and matching edges', () => {
  const entries = demoEntries(photos);
  expect(entries.map(({ view }) => view.dayKey)).toEqual([
    '2026-10-30',
    '2026-10-29',
    '2026-10-28',
    '2026-10-27',
    '2026-10-26',
    '2026-10-25',
  ]);
  expect(entries.map(({ view }) => view.pieces.length)).toEqual([
    12, 9, 7, 10, 8, 6,
  ]);
  const allIds = new Set<string>();
  for (const { view, uris } of entries) {
    const cells = new Map(
      view.pieces.map((p) => [`${p.position.x},${p.position.y}`, p]),
    );
    expect(cells.size).toBe(view.pieces.length);
    expect(new Set(Object.values(uris)).size).toBe(view.pieces.length);
    const visited = new Set<string>();
    const queue = [view.pieces[0]!];
    for (const piece of queue) {
      if (visited.has(piece.id)) continue;
      visited.add(piece.id);
      for (const [dx, dy, direction, opposite] of [
        [0, -1, 'north', 'south'],
        [1, 0, 'east', 'west'],
        [0, 1, 'south', 'north'],
        [-1, 0, 'west', 'east'],
      ] as const) {
        const neighbor = cells.get(
          `${piece.position.x + dx},${piece.position.y + dy}`,
        );
        if (!neighbor) continue;
        const [shape, polarity] = piece.edges[direction].split('-');
        expect(neighbor.edges[opposite]).toBe(
          `${shape}-${polarity === 'out' ? 'in' : 'out'}`,
        );
        if (!visited.has(neighbor.id)) queue.push(neighbor);
      }
    }
    expect(visited.size).toBe(view.pieces.length);
    for (const piece of view.pieces) {
      expect(allIds.has(piece.id)).toBe(false);
      allIds.add(piece.id);
      expect(photos).toContain(uris[piece.id]);
    }
  }
  expect(new Set(Object.values(entries[0]!.uris))).toEqual(new Set(photos));
  expect(demoEntries(photos)).toEqual(entries);
});
test('source stays ready with stable snapshots without server calls or persistence', async () => {
  const source = demoGallerySource(photos);
  const snapshot = source.snapshot();
  const listener = jest.fn();
  const unsubscribe = source.subscribe(listener);
  await source.load();
  await source.sync();
  expect(source.snapshot()).toBe(snapshot);
  expect(snapshot.status).toBe('ready');
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
  expect(() => demoEntries(photos.slice(1))).toThrow();
  expect(() => demoEntries([...photos.slice(1), ''])).toThrow();
});
