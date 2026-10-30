import { boardViewSchema, fitRequestSchema } from '@puzzle-sns/contracts';
import { dayKeyAt } from '../src/domain/time';
import { mergeIdentity } from '../src/domain/seed';
import { requireCaller } from '../src/entrypoints/auth';

test.each([
  ['2026-10-09T18:59:59.999Z', '2026-10-09'],
  ['2026-10-09T19:00:00.000Z', '2026-10-10'],
  ['2026-12-31T19:00:00Z', '2027-01-01'],
  ['2024-02-28T19:00:00Z', '2024-02-29'],
])('JST 4am date boundary at %s', (time, expected) => {
  expect(dayKeyAt(Date.parse(time))).toBe(expected);
});
test.each([-1, NaN, Infinity, 0.1])('rejects invalid server time %s', (value) =>
  expect(() => dayKeyAt(value)).toThrow(),
);
test('merge seed uses latest versions and canonical board order', () => {
  const a = { id: 'a', version: 1 };
  const b = { id: 'b', version: 7 };
  expect(mergeIdentity('session', [a, b])).toEqual(
    mergeIdentity('session', [b, a]),
  );
  expect(mergeIdentity('session', [a, b])).not.toEqual(
    mergeIdentity('session', [{ ...a, version: 2 }, b]),
  );
  expect(mergeIdentity('session', [a, b])).not.toEqual(
    mergeIdentity('other', [a, b]),
  );
});
test('callable guard requires anonymous auth and validated App Check context', () => {
  const auth = {
    uid: 'synthetic',
    token: { firebase: { sign_in_provider: 'anonymous' } },
  };
  expect(() => requireCaller({})).toThrow('unauthenticated');
  expect(() => requireCaller({ auth })).toThrow('permission-denied');
  expect(() =>
    requireCaller({
      auth: {
        ...auth,
        token: { firebase: { sign_in_provider: 'google.com' } },
      },
      app: { appId: 'synthetic-app' },
    }),
  ).toThrow('unauthenticated');
  expect(requireCaller({ auth, app: { appId: 'synthetic-app' } })).toBe(
    'synthetic',
  );
});
test('public contracts reject private fields, client placement/seed and blank-piece content', () => {
  expect(() =>
    fitRequestSchema.parse({
      sessionId: 's',
      uid: 'victim',
      seed: 1,
      placement: {},
    }),
  ).toThrow();
  const piece = {
    id: 'p',
    position: { x: 0, y: 0 },
    edges: {
      north: 'round-in',
      east: 'round-in',
      south: 'round-in',
      west: 'round-in',
    },
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  };
  const view = {
    boardId: 'b',
    dayKey: '2026-10-10',
    version: 1,
    pieces: [piece],
  };
  expect(boardViewSchema.parse(view)).toEqual(view);
  expect(() =>
    boardViewSchema.parse({ ...view, safetyId: 'private' }),
  ).toThrow();
  expect(() =>
    boardViewSchema.parse({
      ...view,
      pieces: [{ ...piece, username: 'hidden name' }],
    }),
  ).toThrow();
});
