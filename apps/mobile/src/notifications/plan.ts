import { MAX_PIECES, type DayState } from '@puzzle-sns/contracts';

export type ReminderKind = 'morning' | 'noon';
export interface Reminder {
  kind: ReminderKind;
  atMs: number;
}
export const REMINDER_TEXT: Record<
  ReminderKind,
  { title: string; body: string }
> = {
  morning: { title: '今日の写真', body: '今日のピースを作りましょう。' },
  noon: { title: 'FIT', body: '会った人とFITしてみましょう。' },
};
/** Epoch ms of a Japan-time hour on a server day key (JST has no daylight saving). */
function jstHour(dayKey: string, hour: number, dayOffset = 0): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day! + dayOffset, hour - 9);
}

/**
 * §15 reminders from the server day state. 07:00 only while today's photo is not created;
 * 12:00 (G-MEDIA, 2026-10-30) only when the piece is ready and FIT is still possible.
 * Tomorrow's 07:00 is planned too, because tomorrow's photo cannot exist yet.
 * Ended, deleted or completed states get no reminder for today.
 */
export function planReminders(
  day: DayState | null,
  pieces: number,
  nowMs: number,
  active = true,
): Reminder[] {
  if (!day || !active) return [];
  const plan: Reminder[] = [];
  const morning = jstHour(day.dayKey, 7);
  if (day.photoState === 'not-created' && morning > nowMs)
    plan.push({ kind: 'morning', atMs: morning });
  const noon = jstHour(day.dayKey, 12);
  if (day.photoState === 'ready' && pieces < MAX_PIECES && noon > nowMs)
    plan.push({ kind: 'noon', atMs: noon });
  const nextMorning = jstHour(day.dayKey, 7, 1);
  if (nextMorning > nowMs) plan.push({ kind: 'morning', atMs: nextMorning });
  return plan;
}
