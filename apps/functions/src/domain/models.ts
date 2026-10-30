import { z } from 'zod';
import {
  boardGeometrySchema,
  documentIdSchema,
  dayKeySchema,
  edgesSchema,
  fitOutcomeSchema,
} from '@puzzle-sns/contracts';

const epoch = z.number().int().nonnegative();
const uid = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('/'));
export const subjectSchema = z.strictObject({
  status: z.enum(['active', 'suspended', 'ended']),
  accessEpoch: epoch,
});
export type Subject = z.infer<typeof subjectSchema>;
export const memberSchema = z.strictObject({
  uid,
  pieceId: documentIdSchema,
  participantKey: documentIdSchema,
});
export const boardSchema = z.strictObject({
  dayKey: dayKeySchema,
  version: z.number().int().positive(),
  status: z.enum(['active', 'retired']),
  geometry: boardGeometrySchema,
  members: z.array(memberSchema).min(1).max(20),
});
export type CanonicalBoard = z.infer<typeof boardSchema>;
export const dailySchema = z.strictObject({
  dayKey: dayKeySchema,
  boardId: documentIdSchema,
  pieceId: documentIdSchema,
  participantKey: documentIdSchema,
});
export const pieceSchema = z.strictObject({
  ownerUid: uid,
  dayKey: dayKeySchema,
  edges: edgesSchema,
  status: z.enum(['approved', 'deleted', 'removed']),
  username: z.string().nullable(),
  caption: z.string().nullable(),
});
export type PrivatePiece = z.infer<typeof pieceSchema>;
export const approvalSchema = z.strictObject({
  ownerUid: uid,
  dayKey: dayKeySchema,
  status: z.enum(['approved', 'rejected', 'held']),
  normalizedPieceId: documentIdSchema,
  username: z.string(),
  caption: z.string(),
});
export const sessionSchema = z
  .strictObject({
    dayKey: dayKeySchema,
    participants: z.tuple([uid, uid]),
    mutualDetectionVerified: z.boolean(),
    expiresAtMs: z.number().int().nonnegative(),
    confirmed: z.array(uid).max(2),
    outcome: fitOutcomeSchema.nullable(),
    // Board versions at matching time; absent for sessions created by trusted tests.
    boards: z.record(z.string(), z.number().int().positive()).optional(),
    cancelled: z.boolean().optional(),
    // Firestore TTL Timestamp is deliberately not part of client-visible contracts.
    expireAt: z.unknown(),
  })
  .superRefine((session, context) => {
    if (
      session.participants[0] === session.participants[1] ||
      new Set(session.confirmed).size !== session.confirmed.length ||
      session.confirmed.some(
        (value) => !session.participants.includes(value),
      ) ||
      session.outcome?.status === 'waiting'
    )
      context.addIssue({ code: 'custom', message: 'Invalid session state' });
  });
export type FitSession = z.infer<typeof sessionSchema>;
export const mediaAccessSchema = z.strictObject({
  visible: z.boolean(),
  epochs: z.record(z.string(), epoch),
});
export type MediaAccess = z.infer<typeof mediaAccessSchema>;
export const proximityTokenSchema = z.strictObject({
  ownerUid: uid,
  dayKey: dayKeySchema,
  expiresAtMs: z.number().int().nonnegative(),
  // Hash of the last peer token the owner reported detecting; unilateral claims stay here.
  peer: documentIdSchema.nullable(),
  sessionId: documentIdSchema.nullable(),
  expireAt: z.unknown(),
});
export type ProximityToken = z.infer<typeof proximityTokenSchema>;
export const rateLimitSchema = z.strictObject({
  windows: z.record(
    z.string(),
    z.strictObject({
      startMs: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
    }),
  ),
  expireAt: z.unknown(),
});
