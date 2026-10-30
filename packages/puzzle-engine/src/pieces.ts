import {
  EDGE_KINDS,
  identifierSchema,
  type EdgeKind,
  type Edges,
  type PieceGeometry,
} from '@puzzle-sns/contracts';
import { randomIndex, type RandomSource } from './random';

const COMPLEMENTS: Record<EdgeKind, EdgeKind> = {
  'round-out': 'round-in',
  'round-in': 'round-out',
  'square-out': 'square-in',
  'square-in': 'square-out',
};

export function edgesFit(a: EdgeKind, b: EdgeKind): boolean {
  return COMPLEMENTS[a] === b;
}

export function generateEdges(random: RandomSource): Edges {
  const draw = (): EdgeKind => {
    const kind = EDGE_KINDS[randomIndex(EDGE_KINDS.length, random)];
    if (kind === undefined) throw new RangeError('Invalid edge index');
    return kind;
  };
  return { north: draw(), east: draw(), south: draw(), west: draw() };
}

/** The authoritative server must call this only after photo approval (Phase 2+). */
export function generatePiece(id: string, random: RandomSource): PieceGeometry {
  return {
    id: identifierSchema.parse(id),
    position: { x: 0, y: 0 },
    edges: generateEdges(random),
  };
}
