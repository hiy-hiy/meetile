import { z } from 'zod';
import { countGraphemes } from 'unicode-segmenter/grapheme';
import { dayKeySchema, documentIdSchema } from './backend';

export const PHOTO = {
  pixels: 1024,
  quality: 80,
  maxUploadBytes: 5 * 1024 * 1024,
} as const;
export function textLength(text: string): number {
  return countGraphemes(text);
}
function text(limit: number) {
  return z
    .string()
    .max(limit * 32)
    .transform((value) => value.normalize('NFC').trim())
    .refine((value) => textLength(value) <= limit, 'Text too long')
    .refine(
      // eslint-disable-next-line no-control-regex -- Explicitly reject control characters in user text.
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      'Invalid control character',
    );
}
export const signatureSchema = text(20);
export const captionSchema = text(140);
export const submitCaptureSchema = z.strictObject({
  captureId: documentIdSchema,
  username: signatureSchema,
  caption: captionSchema,
});
export const captureRequestSchema = z.strictObject({
  captureId: documentIdSchema,
});
export const onboardingSchema = z.strictObject({
  age16OrOlder: z.literal(true),
  accepted: z.literal(true),
  legalVersion: z.string().min(1).max(80),
});
export const uploadCaptureSchema = z.strictObject({
  captureId: documentIdSchema,
  base64: z
    .string()
    .min(4)
    .max(Math.ceil(PHOTO.maxUploadBytes / 3) * 4)
    // Avoid repeated groups: multi-megabyte camera images can overflow a regexp stack.
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0, 'Invalid base64 length'),
});
export const captureStateSchema = z.strictObject({
  captureId: documentIdSchema,
  dayKey: dayKeySchema,
  status: z.enum([
    'open',
    'processing',
    'held',
    'rejected',
    'approved',
    'expired',
    'error',
  ]),
  uploadPath: z.string().regex(/^pending\/[A-Za-z0-9_-]{1,128}\/image$/),
  boardId: documentIdSchema.nullable(),
  username: signatureSchema.nullable(),
  caption: captionSchema.nullable(),
});
export type CaptureState = z.infer<typeof captureStateSchema>;
