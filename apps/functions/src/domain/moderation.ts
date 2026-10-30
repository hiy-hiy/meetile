import { z } from 'zod';

export const moderationPolicySchema = z
  .strictObject({
    textHold: z.number().min(0).max(1),
    textReject: z.number().min(0).max(1),
    bannedWords: z.array(z.string().min(1)).min(1).max(1000),
  })
  .refine((value) => value.textHold < value.textReject);
export type ModerationPolicy = z.infer<typeof moderationPolicySchema>;
export type Decision = 'approved' | 'held' | 'rejected';
export type ImageSignals = { adult: string; racy: string; violence: string };
export type TextSignals = { supported: boolean; scores: number[] };
const compactText = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, '');
/** NFKC and invisible/space removal catch common contact obfuscation; this is not a complete detector. */
export function containsContact(text: string): boolean {
  return /https?:|www\.|(?:[a-z0-9-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)\b|@|(?:\+81|0)(?:\d[-().]?){9,10}|(?:line|ライン|インスタ|instagram|twitter|tiktok|discord|facebook|snapchat|x)(?:id|アカウント|[:：])/u.test(
    compactText(text),
  );
}
export function localTextRejected(
  text: string,
  policy: ModerationPolicy,
): boolean {
  const compact = compactText(text);
  return (
    containsContact(text) ||
    policy.bannedWords.some((word) =>
      compact.includes(
        word.normalize('NFKC').toLowerCase().replace(/\s/gu, ''),
      ),
    )
  );
}
export function decideModeration(
  image: ImageSignals,
  texts: TextSignals[],
  policy: ModerationPolicy,
): Decision {
  const levels = [
    'UNKNOWN',
    'VERY_UNLIKELY',
    'UNLIKELY',
    'POSSIBLE',
    'LIKELY',
    'VERY_LIKELY',
  ];
  const risks = Object.values(image).map((value) => levels.indexOf(value));
  const scores = texts.flatMap((value) => value.scores);
  if (
    risks.some((value) => value >= 4) ||
    scores.some((value) => Number.isFinite(value) && value >= policy.textReject)
  )
    return 'rejected';
  if (
    risks.some((value) => value <= 0 || value === 3) ||
    texts.some((value) => !value.supported || value.scores.length === 0) ||
    scores.some(
      (value) =>
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1 ||
        value >= policy.textHold,
    )
  )
    return 'held';
  return 'approved';
}
