import { z } from 'zod';
import { documentIdSchema } from './backend';

export const deleteOwnPhotoSchema = z.strictObject({
  pieceId: documentIdSchema,
});
export const deletedPhotoSchema = z.strictObject({
  status: z.literal('deleted'),
});

// Initial classification approved for internal verification on 2026-10-29.
export const reportReasons = {
  sexual: '性的な内容',
  violence: '暴力・危険行為',
  harassment: '嫌がらせ・差別',
  'personal-info': '個人情報・連絡先',
  other: 'その他',
} as const;
export const reportReasonSchema = z.enum([
  'sexual',
  'violence',
  'harassment',
  'personal-info',
  'other',
]);
export const reportPhotoSchema = z.strictObject({
  pieceId: documentIdSchema,
  reason: reportReasonSchema,
});
export type PendingReport = z.infer<typeof reportPhotoSchema>;
export const reportedPhotoSchema = z.strictObject({
  status: z.literal('reported'),
});

export const blockPhotoSchema = z.strictObject({
  pieceId: documentIdSchema,
});
export type PendingBlock = z.infer<typeof blockPhotoSchema>;
export const blockedPhotoSchema = z.strictObject({
  status: z.literal('blocked'),
});

// D-06: the caller is resolved from Auth only; the literal guards against an
// accidental empty request reaching an irreversible operation.
export const endUseSchema = z.strictObject({
  confirm: z.literal(true),
});
export const endedUseSchema = z.strictObject({
  status: z.literal('ended'),
});
