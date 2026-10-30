import { z } from 'zod';
import { edgesSchema, pieceGeometrySchema } from './geometry';

// Document identifiers are opaque, never auth UIDs supplied by callers.
export const documentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const publicPieceSchema = pieceGeometrySchema
  .extend({
    visibility: z.enum(['visible', 'blank']),
    photoRef: z
      .string()
      .regex(/^normalized\/[A-Za-z0-9_-]{1,128}\/image$/)
      .nullable(),
    username: z.string().nullable(),
    caption: z.string().nullable(),
  })
  .superRefine((piece, context) => {
    if (
      piece.visibility === 'blank' &&
      (piece.photoRef !== null ||
        piece.username !== null ||
        piece.caption !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Blank pieces cannot contain personal content',
      });
    }
    if (
      piece.visibility === 'visible' &&
      (piece.photoRef !== `normalized/${piece.id}/image` ||
        piece.username === null ||
        piece.caption === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Visible pieces require normalized content',
      });
    }
  });
export const boardViewSchema = z.strictObject({
  boardId: documentIdSchema,
  dayKey: dayKeySchema,
  version: z.number().int().positive(),
  pieces: z.array(publicPieceSchema).min(1).max(20),
});
export type BoardView = z.infer<typeof boardViewSchema>;
export const dayStateSchema = z.strictObject({
  dayKey: dayKeySchema,
  serverTimeMs: z.number().int().nonnegative(),
  ownPieceId: documentIdSchema.nullable(),
  boardId: documentIdSchema.nullable(),
  photoState: z.enum(['not-created', 'ready', 'unavailable']),
});
export type DayState = z.infer<typeof dayStateSchema>;
export const clientStateSchema = z.strictObject({
  dayKey: dayKeySchema,
  boardId: documentIdSchema.nullable(),
  accessRevision: z.number().int().nonnegative(),
});
export const emptyRequestSchema = z.strictObject({});
export const boardRequestSchema = z.strictObject({ boardId: documentIdSchema });
/** The caller's finished boards (days before the current server day), newest first. */
export const galleryListSchema = z.strictObject({
  entries: z
    .array(z.strictObject({ boardId: documentIdSchema, dayKey: dayKeySchema }))
    .max(400),
});
export type GalleryList = z.infer<typeof galleryListSchema>;
export const fitRequestSchema = z.strictObject({ sessionId: documentIdSchema });
export const fitOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('waiting') }),
  z.strictObject({ status: z.literal('merged'), boardId: documentIdSchema }),
  z.strictObject({
    status: z.literal('not-merged'),
    reason: z.enum([
      'already-connected',
      'duplicate-participants',
      'duplicate-pieces',
      'piece-limit',
      'no-placement',
    ]),
  }),
]);
export type FitOutcome = z.infer<typeof fitOutcomeSchema>;
// Proximity tokens are 128-bit random values; they carry no photo, name or safety ID.
export const fitTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const beginFitScanResultSchema = z.strictObject({
  token: fitTokenSchema,
  expiresAtMs: z.number().int().nonnegative(),
});
export type BeginFitScanResult = z.infer<typeof beginFitScanResultSchema>;
export const reportProximityRequestSchema = z.strictObject({
  token: fitTokenSchema,
  peerToken: fitTokenSchema,
  method: z.enum(['ble', 'uwb']),
});
export const proximityResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('waiting') }),
  z.strictObject({ status: z.literal('matched'), sessionId: documentIdSchema }),
  z.strictObject({ status: z.literal('already-connected') }),
  z.strictObject({ status: z.literal('conflict') }),
  z.strictObject({ status: z.literal('expired') }),
]);
export type ProximityResult = z.infer<typeof proximityResultSchema>;
// Only the counterpart's own piece for this session; never their board or identifiers.
export const fitPreviewSchema = z.strictObject({
  sessionId: documentIdSchema,
  visibility: z.enum(['visible', 'blank']),
  edges: edgesSchema,
  username: z.string().nullable(),
  caption: z.string().nullable(),
  imageBase64: z.string().nullable(),
});
export type FitPreview = z.infer<typeof fitPreviewSchema>;
export const leaveFitResultSchema = z.strictObject({ cancelled: z.boolean() });
export const fitViewSchema = z.strictObject({
  sessionId: documentIdSchema,
  stage: z.enum(['matched', 'merged', 'not-merged', 'cancelled']),
  reason: z
    .enum([
      'already-connected',
      'duplicate-participants',
      'duplicate-pieces',
      'piece-limit',
      'no-placement',
    ])
    .nullable(),
  boardId: documentIdSchema.nullable(),
  // True when a board changed after matching, so the retry judged a newer board.
  boardChanged: z.boolean(),
});
export type FitView = z.infer<typeof fitViewSchema>;
