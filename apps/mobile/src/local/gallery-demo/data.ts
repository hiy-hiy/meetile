import {
  boardViewSchema,
  EDGE_KINDS,
  type EdgeKind,
} from '@puzzle-sns/contracts';
import type { GallerySource } from '../../components/gallery';
import type { GalleryEntry } from '../../gallery/store';
import type { GallerySnapshot } from '../../gallery/controller';

// Curated silhouettes, not server boards or a history of real FITs.
const silhouettes = [
  ['.XX.', 'XXXX', 'XXXX', '.XX.'],
  ['XX..', 'XXXX', '.XXX'],
  ['.X.', 'XXX', 'XX.', '.X.'],
  ['XX..', 'XXXX', '.XXX', '..X.'],
  ['.XX', 'XXX', 'XX.', '.X.'],
  ['.X.', 'XXX', 'XX.'],
];
const opposite: Record<EdgeKind, EdgeKind> = {
  'round-out': 'round-in',
  'round-in': 'round-out',
  'square-out': 'square-in',
  'square-in': 'square-out',
};

export function demoEntries(photos: readonly string[]): GalleryEntry[] {
  if (photos.length !== 12 || photos.some((uri) => !uri))
    throw new Error('撮影用画像を12枚準備してください。');
  return silhouettes.map((rows, day) => {
    const edge = (x: number, y: number, axis: number): EdgeKind =>
      EDGE_KINDS[((x * 17 + y * 31 + day * 13 + axis * 7) >>> 0) % 4]!;
    const positions = rows.flatMap((row, y) =>
      [...row].flatMap((cell, x) => (cell === 'X' ? [{ x, y }] : [])),
    );
    const pieces = positions.map((position, index) => {
      const { x, y } = position;
      const id = `gallery-demo-${day}-${index}`;
      return {
        id,
        position,
        edges: {
          north: opposite[edge(x, y - 1, 1)],
          east: edge(x, y, 0),
          south: edge(x, y, 1),
          west: opposite[edge(x - 1, y, 0)],
        },
        visibility: 'visible' as const,
        photoRef: `normalized/${id}/image`,
        username: '',
        caption: '',
      };
    });
    return {
      view: boardViewSchema.parse({
        boardId: `gallery-demo-${day}`,
        dayKey: `2026-10-${30 - day}`,
        version: 1,
        pieces,
      }),
      uris: Object.fromEntries(
        pieces.map((piece, index) => [
          piece.id,
          // Step five permutes all twelve images before repeating on another day.
          photos[(index * 5 + day * 7) % photos.length]!,
        ]),
      ),
    };
  });
}

/** No port, database, identity, clock, notification or network operations. */
export function demoGallerySource(photos: readonly string[]): GallerySource {
  const state: GallerySnapshot = {
    status: 'ready',
    entries: demoEntries(photos),
  };
  return {
    snapshot: () => state,
    subscribe: () => () => {},
    load: () => Promise.resolve(),
    sync: () => Promise.resolve(),
  };
}
