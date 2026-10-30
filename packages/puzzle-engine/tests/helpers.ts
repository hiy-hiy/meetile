import type {
  BoardGeometry,
  Edges,
  GridPoint,
  PieceGeometry,
  Placement,
} from '@puzzle-sns/contracts';

const ALL_OUT: Edges = {
  north: 'round-out',
  east: 'round-out',
  south: 'round-out',
  west: 'round-out',
};

/** Independent fixture construction: assign opposing sides by cell coordinates, not engine merges. */
export function boardAt(
  cells: readonly GridPoint[],
  prefix: string,
  outer: Edges = ALL_OUT,
): BoardGeometry {
  const positions = new Set(cells.map((cell) => `${cell.x}:${cell.y}`));
  const pieces: PieceGeometry[] = cells.map((position, index) => {
    const edges: Edges = {
      north: positions.has(`${position.x}:${position.y - 1}`)
        ? 'round-in'
        : outer.north,
      east: positions.has(`${position.x + 1}:${position.y}`)
        ? 'round-out'
        : outer.east,
      south: positions.has(`${position.x}:${position.y + 1}`)
        ? 'round-out'
        : outer.south,
      west: positions.has(`${position.x - 1}:${position.y}`)
        ? 'round-in'
        : outer.west,
    };
    return { id: `${prefix}-piece-${index}`, position: { ...position }, edges };
  });
  return {
    pieces,
    participantKeys: pieces.map((_, index) => `${prefix}-member-${index}`),
  };
}

export function lineBoard(
  length: number,
  prefix: string,
  outer?: Edges,
): BoardGeometry {
  return boardAt(
    Array.from({ length }, (_, x) => ({ x, y: 0 })),
    prefix,
    outer,
  );
}

/** Exhaustive bounding-box oracle using pair comparisons, not boundary enumeration or engine helpers. */
export function oraclePlacements(
  a: BoardGeometry,
  b: BoardGeometry,
): readonly Placement[] {
  const min = (board: BoardGeometry, axis: 'x' | 'y'): number =>
    Math.min(...board.pieces.map((p) => p.position[axis]));
  const max = (board: BoardGeometry, axis: 'x' | 'y'): number =>
    Math.max(...board.pieces.map((p) => p.position[axis]));
  const complement: Readonly<Record<string, string>> = {
    'round-out': 'round-in',
    'round-in': 'round-out',
    'square-out': 'square-in',
    'square-in': 'square-out',
  };
  const placements: Placement[] = [];
  for (
    let dx = min(a, 'x') - max(b, 'x') - 1;
    dx <= max(a, 'x') - min(b, 'x') + 1;
    dx++
  ) {
    for (
      let dy = min(a, 'y') - max(b, 'y') - 1;
      dy <= max(a, 'y') - min(b, 'y') + 1;
      dy++
    ) {
      let count = 0;
      let invalid = false;
      for (const left of a.pieces) {
        for (const right of b.pieces) {
          const x = right.position.x + dx - left.position.x;
          const y = right.position.y + dy - left.position.y;
          if (x === 0 && y === 0) invalid = true;
          if (Math.abs(x) + Math.abs(y) !== 1) continue;
          count++;
          const matched =
            x === 1
              ? complement[left.edges.east] === right.edges.west
              : x === -1
                ? complement[left.edges.west] === right.edges.east
                : y === 1
                  ? complement[left.edges.south] === right.edges.north
                  : complement[left.edges.north] === right.edges.south;
          if (!matched) invalid = true;
        }
      }
      if (!invalid && count > 0)
        placements.push({ translation: { x: dx, y: dy }, contactCount: count });
    }
  }
  return placements;
}

/** Independently try every bounded translation, ignoring edge kinds and other overlaps. */
export function oracleContactTranslations(
  a: BoardGeometry,
  b: BoardGeometry,
): readonly GridPoint[] {
  const coordinates = (board: BoardGeometry, axis: 'x' | 'y') =>
    board.pieces.map((p) => p.position[axis]);
  const candidates: GridPoint[] = [];
  for (
    let dx =
      Math.min(...coordinates(a, 'x')) - Math.max(...coordinates(b, 'x')) - 1;
    dx <=
    Math.max(...coordinates(a, 'x')) - Math.min(...coordinates(b, 'x')) + 1;
    dx++
  ) {
    for (
      let dy =
        Math.min(...coordinates(a, 'y')) - Math.max(...coordinates(b, 'y')) - 1;
      dy <=
      Math.max(...coordinates(a, 'y')) - Math.min(...coordinates(b, 'y')) + 1;
      dy++
    ) {
      const exposedContact = a.pieces.some((left) =>
        b.pieces.some((right) => {
          const x = right.position.x + dx - left.position.x;
          const y = right.position.y + dy - left.position.y;
          if (Math.abs(x) + Math.abs(y) !== 1) return false;
          const occupiedInA = a.pieces.some(
            (p) =>
              p.position.x === left.position.x + x &&
              p.position.y === left.position.y + y,
          );
          const occupiedInB = b.pieces.some(
            (p) =>
              p.position.x === right.position.x - x &&
              p.position.y === right.position.y - y,
          );
          return !occupiedInA && !occupiedInB;
        }),
      );
      if (exposedContact) candidates.push({ x: dx, y: dy });
    }
  }
  return candidates;
}

export function requirePiece(board: BoardGeometry, id: string): PieceGeometry {
  const piece = board.pieces.find((p) => p.id === id);
  if (!piece) throw new Error(`Missing fixture piece ${id}`);
  return piece;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
