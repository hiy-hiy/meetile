import { z } from 'zod';

export const MAX_PIECES = 20;
export const EDGE_KINDS = [
  'round-out',
  'round-in',
  'square-out',
  'square-in',
] as const;
export const DIRECTIONS = ['north', 'east', 'south', 'west'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type Direction = (typeof DIRECTIONS)[number];

export const edgeKindSchema = z.enum(EDGE_KINDS);
export const edgesSchema = z.strictObject({
  north: edgeKindSchema,
  east: edgeKindSchema,
  south: edgeKindSchema,
  west: edgeKindSchema,
});
export type Edges = Readonly<z.infer<typeof edgesSchema>>;

export const gridPointSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
});
export type GridPoint = Readonly<z.infer<typeof gridPointSchema>>;
export const identifierSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
export const pieceGeometrySchema = z.strictObject({
  id: identifierSchema,
  position: gridPointSchema,
  edges: edgesSchema,
});
export interface PieceGeometry {
  readonly id: string;
  readonly position: GridPoint;
  readonly edges: Edges;
}

/** Internal engine input, not a public board DTO. Never use safety IDs as these keys. */
export interface BoardGeometry {
  readonly pieces: readonly PieceGeometry[];
  readonly participantKeys: readonly string[];
}
export const boardGeometrySchema = z.strictObject({
  pieces: z.array(pieceGeometrySchema).min(1).max(MAX_PIECES),
  participantKeys: z.array(identifierSchema).min(1).max(MAX_PIECES),
});

export const seedSchema = z.number().int().min(0).max(0xffff_ffff);

export interface Placement {
  readonly translation: GridPoint;
  readonly contactCount: number;
}

export type MergeFailureReason =
  | 'duplicate-participants'
  | 'duplicate-pieces'
  | 'piece-limit'
  | 'no-placement';
export type MergeResult =
  | {
      readonly status: 'merged';
      readonly board: BoardGeometry;
      readonly placement: Placement;
      readonly validCandidateCount: number;
      readonly maximalCandidateCount: number;
    }
  | { readonly status: 'not-merged'; readonly reason: MergeFailureReason };
