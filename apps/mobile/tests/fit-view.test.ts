import { fitViewSchema } from '@puzzle-sns/contracts';
import { fitViewData } from '../src/fit/view';

// Same shape as functions' writeFitViews: the contract view plus the TTL field.
const stored = {
  sessionId: 's_synthetic',
  stage: 'cancelled',
  reason: null,
  boardId: null,
  boardChanged: false,
  expireAt: { seconds: 1, nanoseconds: 0 },
};

test('the stored FIT view is rejected by the strict contract until the TTL field is removed', () => {
  expect(fitViewSchema.safeParse(stored).success).toBe(false);
  const view = fitViewData(stored);
  expect(fitViewSchema.parse(view)).toEqual({
    sessionId: 's_synthetic',
    stage: 'cancelled',
    reason: null,
    boardId: null,
    boardChanged: false,
  });
  expect(stored.expireAt).toBeDefined();
});

test('other fields stay strict and non-object values pass through unchanged', () => {
  expect(
    fitViewSchema.safeParse(fitViewData({ ...stored, peer: 'x' })).success,
  ).toBe(false);
  expect(fitViewData(null)).toBeNull();
  expect(fitViewData(undefined)).toBeUndefined();
  expect(fitViewData(['cancelled'])).toEqual(['cancelled']);
});
