import {
  boardGeometrySchema,
  edgeKindSchema,
  gridPointSchema,
  pieceGeometrySchema,
  seedSchema,
  endUseSchema,
  endedUseSchema,
} from '../src';

const piece = {
  id: 'synthetic-a',
  position: { x: 0, y: 0 },
  edges: {
    north: 'round-out',
    east: 'round-in',
    south: 'square-out',
    west: 'square-in',
  },
};

describe('strict geometry contracts', () => {
  test.each(['round-out', 'round-in', 'square-out', 'square-in'])(
    'accepts %s',
    (kind) => {
      expect(edgeKindSchema.parse(kind)).toBe(kind);
    },
  );
  test.each(['flat', 'triangle-out', '', null])(
    'rejects unsupported edge %s',
    (kind) => {
      expect(edgeKindSchema.safeParse(kind).success).toBe(false);
    },
  );
  test.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])(
    'rejects invalid coordinate %s',
    (x) => {
      expect(gridPointSchema.safeParse({ x, y: 0 }).success).toBe(false);
    },
  );
  test('accepts negative integer coordinates', () => {
    expect(gridPointSchema.parse({ x: -5, y: 8 })).toEqual({ x: -5, y: 8 });
  });
  test('does not accept private state or photo metadata in a geometry piece', () => {
    expect(
      pieceGeometrySchema.safeParse({ ...piece, safetyId: 'private' }).success,
    ).toBe(false);
    expect(
      pieceGeometrySchema.safeParse({ ...piece, photo: 'image' }).success,
    ).toBe(false);
  });
  test('requires all four sides and a nonempty piece ID', () => {
    expect(
      pieceGeometrySchema.safeParse({ ...piece, edges: { north: 'round-out' } })
        .success,
    ).toBe(false);
    expect(pieceGeometrySchema.safeParse({ ...piece, id: ' ' }).success).toBe(
      false,
    );
  });
  test('rejects missing, empty, and oversized board arrays', () => {
    expect(
      boardGeometrySchema.safeParse({ pieces: [], participantKeys: [] })
        .success,
    ).toBe(false);
    expect(boardGeometrySchema.safeParse({ pieces: [piece] }).success).toBe(
      false,
    );
    expect(
      boardGeometrySchema.safeParse({
        pieces: Array(21).fill(piece),
        participantKeys: ['a'],
      }).success,
    ).toBe(false);
    expect(
      boardGeometrySchema.safeParse({
        pieces: [piece],
        participantKeys: Array(21).fill('a'),
      }).success,
    ).toBe(false);
  });
  test('accepts an internal board and rejects extra moderation fields', () => {
    const board = { pieces: [piece], participantKeys: ['synthetic-member'] };
    expect(boardGeometrySchema.parse(board)).toEqual(board);
    expect(
      boardGeometrySchema.safeParse({ ...board, reports: [] }).success,
    ).toBe(false);
  });
  test.each([-1, 0.5, 0x1_0000_0000, NaN, Infinity])(
    'rejects invalid seed %s',
    (seed) => {
      expect(seedSchema.safeParse(seed).success).toBe(false);
    },
  );
  test.each([0, 0xffff_ffff])('accepts uint32 boundary %s', (seed) => {
    expect(seedSchema.parse(seed)).toBe(seed);
  });
});

describe('end-of-use request', () => {
  test('requires the explicit confirmation literal only', () => {
    expect(endUseSchema.parse({ confirm: true })).toEqual({ confirm: true });
    for (const input of [
      {},
      { confirm: false },
      { confirm: 'true' },
      { confirm: true, uid: 'someone-else' },
    ])
      expect(endUseSchema.safeParse(input).success).toBe(false);
  });
  test('returns only a generic receipt', () => {
    expect(
      endedUseSchema.safeParse({ status: 'ended', jobId: 'private' }).success,
    ).toBe(false);
  });
});
