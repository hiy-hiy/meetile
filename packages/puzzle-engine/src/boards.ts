import {
  DIRECTIONS,
  boardGeometrySchema,
  type BoardGeometry,
  type Direction,
  type GridPoint,
  type PieceGeometry,
} from '@puzzle-sns/contracts';
import { edgesFit } from './pieces';

export const SIDES: Readonly<
  Record<
    Direction,
    { readonly dx: number; readonly dy: number; readonly opposite: Direction }
  >
> = {
  north: { dx: 0, dy: -1, opposite: 'south' },
  east: { dx: 1, dy: 0, opposite: 'west' },
  south: { dx: 0, dy: 1, opposite: 'north' },
  west: { dx: -1, dy: 0, opposite: 'east' },
};

export class InvalidBoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBoardError';
  }
}

export function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value))
    throw new InvalidBoardError('Coordinate arithmetic exceeds safe integers');
  return value === 0 ? 0 : value;
}

export function cellKey(point: GridPoint): string {
  return `${point.x},${point.y}`;
}

export function shifted(point: GridPoint, translation: GridPoint): GridPoint {
  return {
    x: safeInteger(point.x + translation.x),
    y: safeInteger(point.y + translation.y),
  };
}

export function neighbor(point: GridPoint, direction: Direction): GridPoint {
  const side = SIDES[direction];
  return shifted(point, { x: side.dx, y: side.dy });
}

export function cellsOf(
  board: BoardGeometry,
): ReadonlyMap<string, PieceGeometry> {
  return new Map(board.pieces.map((piece) => [cellKey(piece.position), piece]));
}

/** Structural validation and the invariants of an already committed board. */
export function validateBoard(input: unknown): BoardGeometry {
  const parsed = boardGeometrySchema.safeParse(input);
  if (!parsed.success) throw new InvalidBoardError('Invalid board structure');
  const board = parsed.data;
  if (board.participantKeys.length !== board.pieces.length) {
    throw new InvalidBoardError(
      'Exactly one participant key per piece is required',
    );
  }
  if (new Set(board.participantKeys).size !== board.participantKeys.length) {
    throw new InvalidBoardError('Duplicate participant keys within board');
  }
  if (
    new Set(board.pieces.map((piece) => piece.id)).size !== board.pieces.length
  ) {
    throw new InvalidBoardError('Duplicate piece IDs within board');
  }
  const cells = cellsOf(board);
  if (cells.size !== board.pieces.length)
    throw new InvalidBoardError('Overlapping cells within board');
  for (const piece of board.pieces) {
    for (const direction of DIRECTIONS) {
      const adjacent = cells.get(cellKey(neighbor(piece.position, direction)));
      if (
        adjacent &&
        !edgesFit(
          piece.edges[direction],
          adjacent.edges[SIDES[direction].opposite],
        )
      ) {
        throw new InvalidBoardError('Mismatched existing contact');
      }
    }
  }
  const first = board.pieces[0];
  if (!first) throw new InvalidBoardError('Empty board');
  const visited = new Set([cellKey(first.position)]);
  const queue: PieceGeometry[] = [first];
  for (let index = 0; index < queue.length; index++) {
    const piece = queue[index];
    if (!piece) throw new InvalidBoardError('Missing board cell');
    for (const direction of DIRECTIONS) {
      const key = cellKey(neighbor(piece.position, direction));
      const adjacent = cells.get(key);
      if (adjacent && !visited.has(key)) {
        visited.add(key);
        queue.push(adjacent);
      }
    }
  }
  if (visited.size !== cells.size)
    throw new InvalidBoardError('Disconnected board');
  return board;
}
