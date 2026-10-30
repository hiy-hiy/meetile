import {
  EDGE_KINDS,
  type BoardGeometry,
  type Edges,
} from '@puzzle-sns/contracts';
import {
  InvalidBoardError,
  createSeededRandom,
  edgesFit,
  enumerateContactTranslations,
  evaluatePlacement,
  findValidPlacements,
  generateEdges,
  generatePiece,
  mergeBoards,
  validateBoard,
} from '../src';
import {
  boardAt,
  deepFreeze,
  lineBoard,
  oraclePlacements,
  requirePiece,
} from './helpers';

const ALL_IN: Edges = {
  north: 'round-in',
  east: 'round-in',
  south: 'round-in',
  west: 'round-in',
};

describe('generation and edge compatibility', () => {
  test('all 16 pairs obey shape and polarity', () => {
    const expected = new Set([
      'round-out/round-in',
      'round-in/round-out',
      'square-out/square-in',
      'square-in/square-out',
    ]);
    for (const a of EDGE_KINDS)
      for (const b of EDGE_KINDS)
        expect(edgesFit(a, b)).toBe(expected.has(`${a}/${b}`));
  });
  test('all 256 four-side combinations and their exact uniform marginals are possible', () => {
    const distinct = new Set<string>();
    const counts = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    for (let value = 0; value < 256; value++) {
      let draw = 0;
      const edges = generateEdges(() => ((value >>> (2 * draw++)) & 3) / 4);
      const kinds = Object.values(edges);
      distinct.add(JSON.stringify(edges));
      for (let side = 0; side < 4; side++) {
        const kind = kinds[side];
        const sideCounts = counts[side];
        if (kind === undefined || !sideCounts)
          throw new Error('Invalid test enumeration');
        const index = EDGE_KINDS.indexOf(kind);
        sideCounts[index] = (sideCounts[index] ?? 0) + 1;
      }
    }
    expect(distinct.size).toBe(256);
    expect(counts).toEqual(Array(4).fill([64, 64, 64, 64]));
    expect(generateEdges(() => 0)).toEqual({
      north: 'round-out',
      east: 'round-out',
      south: 'round-out',
      west: 'round-out',
    });
  });
  test.each([-0.1, 1, NaN, Infinity])(
    'rejects broken random source %s',
    (value) => {
      expect(() => generateEdges(() => value)).toThrow(RangeError);
    },
  );
  test('injects entropy, fixes the initial orientation, and validates the ID', () => {
    let calls = 0;
    const piece = generatePiece('synthetic', () => (calls++ % 4) / 4);
    expect(calls).toBe(4);
    expect(piece).toEqual({
      id: 'synthetic',
      position: { x: 0, y: 0 },
      edges: {
        north: 'round-out',
        east: 'round-in',
        south: 'square-out',
        west: 'square-in',
      },
    });
    expect(() => generatePiece('', () => 0)).toThrow();
  });
  test('reproduces the random stream and rejects invalid seeds', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const values = Array.from({ length: 100 }, a);
    expect(values).toEqual(Array.from({ length: 100 }, b));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(values).not.toEqual(
      Array.from({ length: 100 }, createSeededRandom(43)),
    );
    expect(() => createSeededRandom(-1)).toThrow();
  });
});

describe('existing board validation', () => {
  test.each([
    { pieces: [], participantKeys: [] },
    { ...lineBoard(2, 'a'), participantKeys: ['only-one'] },
    { ...lineBoard(2, 'a'), participantKeys: ['same', 'same'] },
    {
      ...lineBoard(2, 'a'),
      pieces: [
        requirePiece(lineBoard(2, 'a'), 'a-piece-0'),
        requirePiece(lineBoard(2, 'a'), 'a-piece-0'),
      ],
    },
    boardAt(
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
      'gap',
    ),
    boardAt(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      'overlap',
    ),
    boardAt([{ x: Number.MAX_SAFE_INTEGER, y: 0 }], 'overflow'),
  ])(
    'rejects malformed, disconnected, duplicated or unrepresentable input %#',
    (board) => {
      expect(() => validateBoard(board)).toThrow(InvalidBoardError);
    },
  );
  test('rejects incompatible existing contacts', () => {
    const board = lineBoard(2, 'a');
    const bad = {
      ...board,
      pieces: board.pieces.map((piece) => ({
        ...piece,
        edges: { ...piece.edges, east: 'round-in' },
      })),
    };
    expect(() => validateBoard(bad)).toThrow('Mismatched existing contact');
  });
  test('accepts a connected ring with an empty center', () => {
    const ring = boardAt(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 1 },
      ],
      'ring',
    );
    expect(validateBoard(ring)).toEqual(ring);
  });
});

describe('placement and merging', () => {
  test('enumerates the four nonrotating translations of single pieces', () => {
    expect(
      enumerateContactTranslations(lineBoard(1, 'a'), lineBoard(1, 'b')),
    ).toEqual([
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]);
  });
  test('overlap, separated cells, and mismatches are invalid', () => {
    const a = lineBoard(1, 'a');
    const b = lineBoard(1, 'b');
    expect(evaluatePlacement(a, b, { x: 0, y: 0 })).toBeUndefined();
    expect(evaluatePlacement(a, b, { x: 10, y: 10 })).toBeUndefined();
    expect(evaluatePlacement(a, b, { x: 1, y: 0 })).toBeUndefined();
    expect(mergeBoards(a, b, 42)).toEqual({
      status: 'not-merged',
      reason: 'no-placement',
    });
  });
  test('one matching contact does not rescue another mismatched contact', () => {
    const a = lineBoard(2, 'a');
    const base = lineBoard(2, 'b', ALL_IN);
    const b: BoardGeometry = {
      ...base,
      pieces: base.pieces.map((piece, index) =>
        index === 0
          ? piece
          : { ...piece, edges: { ...piece.edges, north: 'round-out' } },
      ),
    };
    expect(evaluatePlacement(a, b, { x: 0, y: 1 })).toBeUndefined();
    expect(oraclePlacements(a, b)).toEqual(findValidPlacements(a, b));
  });
  test('accepts multiple simultaneous contacts and selects the maximum', () => {
    const a = lineBoard(3, 'a');
    const b = lineBoard(3, 'b', ALL_IN);
    const result = mergeBoards(a, b, 7);
    expect(evaluatePlacement(a, b, { x: 0, y: 1 })?.contactCount).toBe(3);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('Expected merge');
    expect(result.placement.contactCount).toBe(3);
    expect(result.maximalCandidateCount).toBe(2);
    expect(result.validCandidateCount).toBeGreaterThan(
      result.maximalCandidateCount,
    );
  });
  test('four-sided contact can fill a hole when all sides fit', () => {
    const ring = boardAt(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 1 },
      ],
      'ring',
    );
    const result = mergeBoards(ring, lineBoard(1, 'b', ALL_IN), 1);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('Expected hole fill');
    expect(result.placement).toEqual({
      translation: { x: 1, y: 1 },
      contactCount: 4,
    });
  });
  test('rigidly translates B, holds A fixed, and leaves frozen inputs untouched', () => {
    const a = deepFreeze(lineBoard(3, 'a'));
    const b = deepFreeze(lineBoard(3, 'b', ALL_IN));
    const before = JSON.stringify({ a, b });
    const result = mergeBoards(a, b, 42);
    if (result.status !== 'merged') throw new Error('Expected merge');
    for (const piece of a.pieces)
      expect(requirePiece(result.board, piece.id)).toEqual(piece);
    for (const piece of b.pieces) {
      expect(requirePiece(result.board, piece.id)).toEqual({
        ...piece,
        position: {
          x: piece.position.x + result.placement.translation.x,
          y: piece.position.y + result.placement.translation.y,
        },
      });
    }
    expect(JSON.stringify({ a, b })).toBe(before);
    expect(validateBoard(result.board)).toEqual(result.board);
  });
  test('seed and input enumeration order do not change retries', () => {
    const a = lineBoard(3, 'a');
    const b = lineBoard(3, 'b', ALL_IN);
    const reversed = (board: BoardGeometry): BoardGeometry => ({
      pieces: [...board.pieces].reverse(),
      participantKeys: [...board.participantKeys].reverse(),
    });
    expect(mergeBoards(a, b, 123)).toEqual(
      mergeBoards(reversed(a), reversed(b), 123),
    );
    const outcomes = new Set(
      Array.from({ length: 64 }, (_, seed) =>
        JSON.stringify(mergeBoards(a, b, seed)),
      ),
    );
    expect(outcomes.size).toBe(2);
  });
  test('rejects same-board and shared participants without making changes', () => {
    const a = lineBoard(1, 'a');
    const b = {
      ...lineBoard(1, 'b', ALL_IN),
      participantKeys: a.participantKeys,
    };
    expect(mergeBoards(a, a, 0)).toEqual({
      status: 'not-merged',
      reason: 'duplicate-participants',
    });
    expect(mergeBoards(a, b, 0)).toEqual({
      status: 'not-merged',
      reason: 'duplicate-participants',
    });
    expect(findValidPlacements(a, b)).toEqual([]);
    expect(evaluatePlacement(a, b, { x: 1, y: 0 })).toBeUndefined();
  });
  test('rejects duplicated piece IDs across otherwise different participants', () => {
    const a = lineBoard(1, 'a');
    const original = lineBoard(1, 'b', ALL_IN);
    const b = {
      ...original,
      pieces: original.pieces.map((piece) => ({ ...piece, id: 'a-piece-0' })),
    };
    expect(mergeBoards(a, b, 0)).toEqual({
      status: 'not-merged',
      reason: 'duplicate-pieces',
    });
  });
  test('allows exactly 20 pieces and rejects 21', () => {
    const a = lineBoard(19, 'a');
    const b = lineBoard(1, 'b', ALL_IN);
    const result = mergeBoards(a, b, 10);
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('Expected 20-piece board');
    expect(result.board.pieces).toHaveLength(20);
    expect(mergeBoards(result.board, lineBoard(1, 'c', ALL_IN), 10)).toEqual({
      status: 'not-merged',
      reason: 'piece-limit',
    });
  });
  test('rejects malformed inputs and arithmetic overflow before producing a result', () => {
    expect(() => mergeBoards({}, lineBoard(1, 'a'), 0)).toThrow(
      InvalidBoardError,
    );
    expect(() =>
      mergeBoards(lineBoard(1, 'a'), lineBoard(1, 'b'), -1),
    ).toThrow();
    const a = boardAt([{ x: Number.MAX_SAFE_INTEGER - 2, y: 0 }], 'a');
    const b = boardAt([{ x: -Number.MAX_SAFE_INTEGER + 2, y: 0 }], 'b', ALL_IN);
    expect(() => mergeBoards(a, b, 0)).toThrow('safe integers');
  });
});
