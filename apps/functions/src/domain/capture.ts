import { z } from 'zod';
import {
  captureStateSchema,
  captionSchema,
  signatureSchema,
} from '@puzzle-sns/contracts';
export const privateCaptureSchema = captureStateSchema
  .omit({ captureId: true })
  .extend({
    ownerUid: z.string().min(1).max(128),
    pieceId: z.string().uuid(),
    expiresAtMs: z.number().int().positive(),
    username: signatureSchema.nullable(),
    caption: captionSchema.nullable(),
    leaseToken: z.string().nullable(),
    leaseUntilMs: z.number().int().nonnegative(),
  });
export type PrivateCapture = z.infer<typeof privateCaptureSchema>;
