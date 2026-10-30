import fc from 'fast-check';
import {
  EDGE_KINDS,
  type BoardGeometry,
  type Edges,
  type GridPoint,
} from '@puzzle-sns/contracts';
import {
  createSeededRandom,
  enumerateContactTranslations,
  findValidPlacements,
  generatePiece,
  mergeBoards,
} from '../src';
import {
  boardAt,
  oracleContactTranslations,
  oraclePlacements,
  requirePiece,
} from './helpers';

const edgesArbitrary = fc.record({
  north: fc.constantFrom(...EDGE_KINDS),
  east: fc.constantFrom(...EDGE_KINDS),
  south: fc.constantFrom(...EDGE_KINDS),
  west: fc.constantFrom(...EDGE_KINDS),
});
const shapeArbitrary = fc
  .record({
    steps: fc.array(fc.constantFrom('north', 'east', 'south', 'west'), {
      maxLength: 6,
    }),
    x: fc.integer({ min: -5, max: 5 }),
    y: fc.integer({ min: -5, max: 5 }),
    edges: edgesArbitrary,
  })
  .map(({ steps, x, y, edges }) => {
    const cells = new Map<string, GridPoint>();
    let current = { x, y };
    cells.set(`${x},${y}`, current);
    for (const direction of steps) {
      current = {
        x:
          current.x +
          (direction === 'east' ? 1 : direction === 'west' ? -1 : 0),
        y:
          current.y +
          (direction === 'south' ? 1 : direction === 'north' ? -1 : 0),
      };
      cells.set(`${current.x},${current.y}`, current);
    }
    return { cells: [...cells.values()], edges };
  });
const seedArbitrary = fc.integer({ min: 0, max: 0xffff_ffff });

function independentBoardInvariants(board: BoardGeometry): void {
  expect(board.pieces.length).toBeLessThanOrEqual(20);
  expect(new Set(board.pieces.map((piece) => piece.id)).size).toBe(
    board.pieces.length,
  );
  expect(new Set(board.participantKeys).size).toBe(board.pieces.length);
  expect(
    new Set(
      board.pieces.map((piece) => `${piece.position.x}:${piece.position.y}`),
    ).size,
  ).toBe(board.pieces.length);
  const complements: Readonly<Record<string, string>> = {
    'round-out': 'round-in',
    'round-in': 'round-out',
    'square-out': 'square-in',
    'square-in': 'square-out',
  };
  const first = board.pieces[0];
  if (!first) throw new Error('Empty resulting board');
  const reached = new Set([first.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of board.pieces) {
      for (const b of board.pieces) {
        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
        const match =
          dx === 1
            ? complements[a.edges.east] === b.edges.west
            : dx === -1
              ? complements[a.edges.west] === b.edges.east
              : dy === 1
                ? complements[a.edges.south] === b.edges.north
                : complements[a.edges.north] === b.edges.south;
        expect(match).toBe(true);
        if (reached.has(a.id) && !reached.has(b.id)) {
          reached.add(b.id);
          changed = true;
        }
      }
    }
  }
  expect(reached.size).toBe(board.pieces.length);
}

describe('property-based puzzle invariants', () => {
  test('all valid candidates match independent exhaustive search, and maxima are selected', () => {
    fc.assert(
      fc.property(
        shapeArbitrary,
        shapeArbitrary,
        seedArbitrary,
        (left, right, seed) => {
          const a = boardAt(left.cells, 'a', left.edges);
          const b = boardAt(right.cells, 'b', right.edges);
          const before = JSON.stringify({ a, b });
          const oracle = oraclePlacements(a, b);
          expect(enumerateContactTranslations(a, b)).toEqual(
            oracleContactTranslations(a, b),
          );
          expect(findValidPlacements(a, b)).toEqual(oracle);
          const result = mergeBoards(a, b, seed);
          expect(result).toEqual(mergeBoards(a, b, seed));
          expect(JSON.stringify({ a, b })).toBe(before);
          if (oracle.length === 0) {
            expect(result).toEqual({
              status: 'not-merged',
              reason: 'no-placement',
            });
            return;
          }
          if (result.status !== 'merged')
            throw new Error('Valid oracle placement was rejected');
          expect(oracle).toContainEqual(result.placement);
          expect(result.placement.contactCount).toBe(
            Math.max(...oracle.map((p) => p.contactCount)),
          );
          expect(result.validCandidateCount).toBe(oracle.length);
          independentBoardInvariants(result.board);
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
        },
      ),
    );
  });
  test('moving both coordinate origins does not change contact choices', () => {
    fc.assert(
      fc.property(
        shapeArbitrary,
        shapeArbitrary,
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        (left, right, x, y) => {
          const a = boardAt(left.cells, 'a', left.edges);
          const b = boardAt(right.cells, 'b', right.edges);
          const translate = (board: BoardGeometry): BoardGeometry => ({
            ...board,
            pieces: board.pieces.map((piece) => ({
              ...piece,
              position: { x: piece.position.x + x, y: piece.position.y + y },
            })),
          });
          expect(findValidPlacements(a, b)).toEqual(
            findValidPlacements(translate(a), translate(b)),
          );
        },
      ),
    );
  });
  test('multiple successful stages preserve every earlier rigid board and all invariants', () => {
    fc.assert(
      fc.property(
        seedArbitrary,
        fc.integer({ min: 2, max: 20 }),
        (seed, total) => {
          const random = createSeededRandom(seed);
          let board: BoardGeometry = {
            pieces: [generatePiece('piece-0', random)],
            participantKeys: ['member-0'],
          };
          for (let index = 1; index < total; index++) {
            const other: BoardGeometry = {
              pieces: [generatePiece(`piece-${index}`, random)],
              participantKeys: [`member-${index}`],
            };
            const before = JSON.stringify(board);
            const oracle = oraclePlacements(board, other);
            const result = mergeBoards(
              board,
              other,
              Math.floor(random() * 0x1_0000_0000),
            );
            if (result.status !== 'merged') {
              expect(oracle).toHaveLength(0);
              expect(JSON.stringify(board)).toBe(before);
              continue;
            }
            expect(result.placement.contactCount).toBe(
              Math.max(...oracle.map((p) => p.contactCount)),
            );
            for (const piece of board.pieces)
              expect(requirePiece(result.board, piece.id)).toEqual(piece);
            expect(result.board.participantKeys.length).toBe(
              board.participantKeys.length + 1,
            );
            board = result.board;
            independentBoardInvariants(board);
          }
        },
      ),
    );
  });
  test('single-piece success rate equals the exact 175/256 calculation', () => {
    const base: Edges = {
      north: 'round-out',
      east: 'round-out',
      south: 'round-out',
      west: 'round-out',
    };
    const a = boardAt([{ x: 0, y: 0 }], 'a', base);
    let successes = 0;
    for (let value = 0; value < 256; value++) {
      const at = (shift: number) => {
        const edge = EDGE_KINDS[(value >>> shift) & 3];
        if (!edge) throw new Error('Invalid enumeration');
        return edge;
      };
      const edges = { north: at(0), east: at(2), south: at(4), west: at(6) };
      if (
        findValidPlacements(a, boardAt([{ x: 0, y: 0 }], 'b', edges)).length > 0
      )
        successes++;
    }
    expect(successes).toBe(175);
    expect(successes / 256).toBe(1 - (3 / 4) ** 4);
  });
});
