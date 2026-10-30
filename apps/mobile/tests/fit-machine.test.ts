import { INITIAL, isActive, reduce, type FitEvent } from '../src/fit/machine';

const view = (
  stage: 'merged' | 'not-merged' | 'cancelled' | 'matched',
  extra = {},
) => ({
  type: 'progress' as const,
  view: {
    sessionId: 's',
    stage,
    reason: null,
    boardId: null,
    boardChanged: false,
    ...extra,
  },
});
function through(...events: FitEvent[]) {
  return events.reduce(reduce, INITIAL);
}
const toPreview = [
  { type: 'start' },
  { type: 'matched', sessionId: 's' },
  { type: 'preview-ready' },
] as const;

test('the happy path runs search, match, preview, wait and merge', () => {
  expect(through(...toPreview).stage).toBe('preview');
  const waiting = through(...toPreview, { type: 'confirmed' });
  expect(waiting.stage).toBe('waiting');
  expect(reduce(waiting, view('merged')).stage).toBe('merged');
});
test('other devices nearby show and clear the multiple state, and a conflict shows it', () => {
  const s = through({ type: 'start' }, { type: 'verdict', status: 'multiple' });
  expect(s.stage).toBe('multiple');
  expect(reduce(s, { type: 'verdict', status: 'searching' }).stage).toBe(
    'searching',
  );
  expect(through({ type: 'start' }, { type: 'conflict' }).stage).toBe(
    'conflict',
  );
});
test('not-merged is told apart from a board changed after matching', () => {
  const waiting = through(...toPreview, { type: 'confirmed' });
  expect(
    reduce(waiting, view('not-merged', { reason: 'no-placement' })),
  ).toMatchObject({ stage: 'not-merged', reason: 'no-placement' });
  expect(
    reduce(
      waiting,
      view('not-merged', { reason: 'no-placement', boardChanged: true }),
    ).stage,
  ).toBe('board-changed');
  expect(reduce(waiting, view('cancelled')).stage).toBe('partner-left');
});
test('progress for another session, or a stale matched view, changes nothing', () => {
  const preview = through(...toPreview);
  const other = view('merged');
  expect(
    reduce(preview, { ...other, view: { ...other.view, sessionId: 'x' } }),
  ).toBe(preview);
  expect(reduce(preview, view('matched'))).toBe(preview);
  expect(reduce(through({ type: 'start' }), view('merged')).stage).toBe(
    'searching',
  );
});
test('terminal stages are not revived by late events', () => {
  const merged = reduce(
    through(...toPreview, { type: 'confirmed' }),
    view('merged'),
  );
  for (const event of [
    { type: 'timeout' },
    { type: 'day-changed' },
    view('cancelled'),
    { type: 'matched', sessionId: 'z' },
    { type: 'verdict', status: 'multiple' },
  ] as const)
    expect(reduce(merged, event).stage).toBe('merged');
  expect(reduce(merged, { type: 'start' }).stage).toBe('searching');
  expect(reduce(merged, { type: 'leave' })).toEqual(INITIAL);
});
test('a date change or timeout ends any active attempt but only active ones', () => {
  for (const state of [through({ type: 'start' }), through(...toPreview)]) {
    expect(isActive(state.stage)).toBe(true);
    expect(reduce(state, { type: 'day-changed' }).stage).toBe('day-changed');
  }
  expect(reduce(through(...toPreview), { type: 'timeout' }).stage).toBe(
    'timeout',
  );
  expect(reduce(through({ type: 'start' }), { type: 'timeout' }).stage).toBe(
    'searching',
  );
  expect(reduce(INITIAL, { type: 'day-changed' })).toBe(INITIAL);
});
test('unavailability keeps its kind and already-connected needs a search', () => {
  expect(
    through({ type: 'start' }, { type: 'unavailable', kind: 'permission' }),
  ).toMatchObject({ stage: 'unavailable', reason: 'permission' });
  expect(through({ type: 'start' }, { type: 'already-connected' }).stage).toBe(
    'already-connected',
  );
  expect(
    reduce(through(...toPreview), { type: 'already-connected' }).stage,
  ).toBe('preview');
});
