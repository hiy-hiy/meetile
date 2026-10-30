import type { DayState } from '@puzzle-sns/contracts';
import { planReminders } from '../src/notifications/plan';

const day = (photoState: DayState['photoState']): DayState => ({
  dayKey: '2026-10-31',
  serverTimeMs: 0,
  ownPieceId: photoState === 'ready' ? 'piece' : null,
  boardId: photoState === 'ready' ? 'board' : null,
  photoState,
});
const jst = (iso: string) => Date.parse(`${iso}+09:00`);
const at = (plan: ReturnType<typeof planReminders>) =>
  plan.map((r) => [r.kind, new Date(r.atMs + 9 * 3600_000).toISOString()]);

test('before 7:00 without a photo: today 7:00 and tomorrow 7:00, no noon reminder', () => {
  expect(
    at(planReminders(day('not-created'), 0, jst('2026-10-31T05:00:00'))),
  ).toEqual([
    ['morning', '2026-10-31T07:00:00.000Z'],
    ['morning', '2026-11-01T07:00:00.000Z'],
  ]);
});

test('with a ready piece before noon: the 12:00 FIT reminder, never a morning one for today', () => {
  expect(
    at(planReminders(day('ready'), 3, jst('2026-10-31T09:00:00'))),
  ).toEqual([
    ['noon', '2026-10-31T12:00:00.000Z'],
    ['morning', '2026-11-01T07:00:00.000Z'],
  ]);
});

test('completed, deleted, past-time and ended states get no reminder for today', () => {
  const nine = jst('2026-10-31T09:00:00');
  for (const plan of [
    planReminders(day('ready'), 20, nine),
    planReminders(day('unavailable'), 3, nine),
    planReminders(day('ready'), 3, jst('2026-10-31T13:00:00')),
  ])
    expect(plan.map((r) => r.kind)).toEqual(['morning']);
  expect(planReminders(day('ready'), 3, nine, false)).toEqual([]);
  expect(planReminders(null, 0, nine)).toEqual([]);
});
