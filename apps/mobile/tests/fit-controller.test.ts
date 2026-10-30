import { FitController } from '../src/fit/controller';
import type { MobilePort } from '../src/controller';
import type { Observation } from '../src/fit/policy';
import type { ProximitySource, UnavailableKind } from '../src/fit/source';

const TOKEN = 'T'.repeat(22);
const PEER = 'P'.repeat(22);
const edges = {
  north: 'round-in',
  east: 'round-in',
  south: 'round-in',
  west: 'round-in',
} as const;
const day = (dayKey: string) => ({
  dayKey,
  serverTimeMs: 1,
  ownPieceId: 'p',
  boardId: 'b',
  photoState: 'ready',
});
const preview = {
  sessionId: 's1',
  visibility: 'visible',
  edges,
  username: 'Synthetic name',
  caption: 'Synthetic caption',
  imageBase64: 'AAAA',
};
class FakeSource implements ProximitySource {
  emit: (value: Observation) => void = () => {};
  unavailable: (kind: UnavailableKind) => void = () => {};
  starts: string[] = [];
  stop = jest.fn();
  async start(
    token: string,
    emit: (value: Observation) => void,
    unavailable: (kind: UnavailableKind) => void,
  ) {
    this.starts.push(token);
    this.emit = emit;
    this.unavailable = unavailable;
  }
}
type Handlers = Record<string, (data: unknown) => unknown>;
function setup(handlers: Handlers = {}) {
  let fitView: (value: unknown) => void = () => {};
  const calls: { name: string; data: unknown }[] = [];
  const base: Handlers = {
    getDayState: () => day('2026-10-10'),
    beginFitScan: () => ({ token: TOKEN, expiresAtMs: 1 }),
    reportProximity: () => ({ status: 'matched', sessionId: 's1' }),
    getFitPreview: () => preview,
    confirmFit: () => ({ status: 'waiting' }),
    leaveFit: () => ({ cancelled: true }),
    ...handlers,
  };
  const port = {
    call: jest.fn(async (name: string, data: unknown) => {
      calls.push({ name, data });
      const handler = base[name];
      if (!handler) throw new Error('unexpected call');
      return handler(data);
    }),
    subscribeFit: (changed: (value: unknown) => void) => {
      fitView = changed;
      return jest.fn();
    },
  } as unknown as MobilePort;
  const source = new FakeSource();
  let now = 10_000;
  const fit = new FitController(port, source, () => now);
  const near = (peer = PEER) => {
    for (let at = now - 1750; at <= now; at += 250)
      source.emit({
        deviceId: 'a',
        token: peer,
        rssi: -40,
        distanceMeters: null,
        atMs: at,
      });
  };
  return {
    fit,
    source,
    calls,
    near,
    pushView: (value: unknown) => fitView(value),
    advance: async (ms: number) => {
      now += ms;
      await jest.advanceTimersByTimeAsync(ms);
    },
    other: () => {
      for (let at = now - 1000; at <= now; at += 250)
        source.emit({
          deviceId: 'b',
          token: null,
          rssi: -50,
          distanceMeters: null,
          atMs: at,
        });
    },
    names: () => calls.map((call) => call.name),
  };
}
const rejection = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('a near peer is reported once matched, previewed, confirmed and merged', async () => {
  const t = setup();
  await t.fit.start();
  expect(t.fit.snapshot().stage).toBe('searching');
  expect(t.source.starts).toEqual([TOKEN]);
  t.near();
  await t.advance(500);
  expect(t.fit.snapshot()).toMatchObject({
    stage: 'preview',
    sessionId: 's1',
    preview: { username: 'Synthetic name' },
  });
  expect(t.calls.find((c) => c.name === 'reportProximity')?.data).toEqual({
    token: TOKEN,
    peerToken: PEER,
    method: 'ble',
  });
  // The radio stops advertising once matched.
  expect(t.source.stop).toHaveBeenCalled();
  await t.fit.confirm();
  expect(t.fit.snapshot().stage).toBe('waiting');
  expect(t.calls.find((c) => c.name === 'confirmFit')?.data).toEqual({
    sessionId: 's1',
  });
  t.pushView({
    sessionId: 's1',
    stage: 'merged',
    reason: null,
    boardId: 'nb',
    boardChanged: false,
  });
  expect(t.fit.snapshot().stage).toBe('merged');
  await t.fit.leave();
  expect(t.names()).not.toContain('leaveFit');
});
test('nothing is reported while the peer is far, unread or one of several', async () => {
  const t = setup();
  await t.fit.start();
  await t.advance(3000);
  expect(t.names()).not.toContain('reportProximity');
  t.other();
  t.near();
  await t.advance(500);
  expect(t.fit.snapshot().stage).toBe('multiple');
  expect(t.names()).not.toContain('reportProximity');
});
test('a waiting claim keeps searching and reports again no faster than once a second', async () => {
  const t = setup({ reportProximity: () => ({ status: 'waiting' }) });
  await t.fit.start();
  t.near();
  await t.advance(500);
  await t.advance(500);
  t.near();
  await t.advance(500);
  const reports = t.names().filter((name) => name === 'reportProximity').length;
  expect(reports).toBeGreaterThanOrEqual(1);
  expect(reports).toBeLessThanOrEqual(2);
  expect(t.fit.snapshot().stage).toBe('searching');
});
test('an expired token is replaced; a conflict asks the user to move apart', async () => {
  let answer = 'expired';
  const t = setup({ reportProximity: () => ({ status: answer }) });
  await t.fit.start();
  t.near();
  await t.advance(500);
  expect(t.names().filter((n) => n === 'beginFitScan')).toHaveLength(2);
  answer = 'conflict';
  await t.advance(500);
  t.near();
  await t.advance(500);
  expect(t.fit.snapshot().stage).toBe('conflict');
  expect(t.source.stop).toHaveBeenCalled();
});
test('people already on one board end without a session', async () => {
  const t = setup({ reportProximity: () => ({ status: 'already-connected' }) });
  await t.fit.start();
  t.near();
  await t.advance(500);
  expect(t.fit.snapshot().stage).toBe('already-connected');
  expect(t.names()).not.toContain('getFitPreview');
});
test('start failures are reported as rate limit, not ready or unsupported', async () => {
  const limited = setup({
    beginFitScan: rejection('functions/resource-exhausted'),
  });
  await limited.fit.start();
  expect(limited.fit.snapshot().stage).toBe('rate-limited');
  const down = setup({ getDayState: rejection('unavailable') });
  await down.fit.start();
  expect(down.fit.snapshot().stage).toBe('not-ready');
  const none = new FitController(
    { call: jest.fn() } as unknown as MobilePort,
    null,
  );
  await none.start();
  expect(none.snapshot()).toMatchObject({
    stage: 'unavailable',
    reason: 'unsupported',
  });
  const t = setup();
  await t.fit.start();
  t.source.unavailable('bluetooth-off');
  expect(t.fit.snapshot()).toMatchObject({
    stage: 'unavailable',
    reason: 'bluetooth-off',
  });
});
test('leaving an unconfirmed session tells the server and clears the preview', async () => {
  const t = setup();
  await t.fit.start();
  t.near();
  await t.advance(500);
  await t.fit.leave();
  expect(t.names()).toContain('leaveFit');
  expect(t.fit.snapshot()).toMatchObject({ stage: 'idle', preview: null });
  expect(t.source.stop).toHaveBeenCalled();
});
test('the partner leaving, an old view and a timeout are handled', async () => {
  const t = setup();
  await t.fit.start();
  t.pushView({
    sessionId: 'old',
    stage: 'merged',
    reason: null,
    boardId: 'x',
    boardChanged: false,
  });
  expect(t.fit.snapshot().stage).toBe('searching');
  t.near();
  await t.advance(500);
  t.pushView({
    sessionId: 's1',
    stage: 'cancelled',
    reason: null,
    boardId: null,
    boardChanged: false,
  });
  expect(t.fit.snapshot().stage).toBe('partner-left');
  const late = setup();
  await late.fit.start();
  late.near();
  await late.advance(500);
  await late.advance(91_000);
  expect(late.fit.snapshot().stage).toBe('timeout');
});
test('a failed confirmation is a date change only if the server day differs', async () => {
  let current = '2026-10-10';
  const t = setup({
    getDayState: () => day(current),
    confirmFit: rejection('failed-precondition'),
  });
  await t.fit.start();
  t.near();
  await t.advance(500);
  current = '2026-10-11';
  await t.fit.confirm();
  expect(t.fit.snapshot().stage).toBe('day-changed');
  const same = setup({ confirmFit: rejection('failed-precondition') });
  await same.fit.start();
  same.near();
  await same.advance(500);
  await same.fit.confirm();
  expect(same.fit.snapshot().stage).toBe('timeout');
});
test('returning to the foreground rechecks the server date', async () => {
  let current = '2026-10-10';
  const t = setup({ getDayState: () => day(current) });
  await t.fit.start();
  current = '2026-10-11';
  await t.fit.recheckDay();
  expect(t.fit.snapshot().stage).toBe('day-changed');
});

test('scans renew at 30 seconds even without a peer and do not report old observations', async () => {
  const t = setup();
  await t.fit.start();
  await t.advance(29_500);
  expect(t.source.starts).toHaveLength(1);
  t.near();
  await t.advance(500);
  expect(t.source.starts).toHaveLength(2);
  await t.advance(500);
  expect(t.names()).not.toContain('reportProximity');
});
test('radio failure stops the controller and ignores a delayed matched response', async () => {
  let resolveReport: (value: unknown) => void = () => {};
  const t = setup({
    reportProximity: () =>
      new Promise((resolve) => {
        resolveReport = resolve;
      }),
  });
  await t.fit.start();
  t.near();
  await t.advance(500);
  t.source.unavailable('permission');
  resolveReport({ status: 'matched', sessionId: 'late-session' });
  await t.advance(500);
  expect(t.fit.snapshot()).toMatchObject({
    stage: 'unavailable',
    reason: 'permission',
    preview: null,
  });
  expect(t.names()).not.toContain('getFitPreview');
  expect(t.calls).toContainEqual({
    name: 'leaveFit',
    data: { sessionId: 'late-session' },
  });
  const count = t.calls.length;
  t.near();
  await t.advance(31_000);
  expect(t.calls).toHaveLength(count);
});

test('a waiting token-bound claim receives the match after the counterpart stops advertising', async () => {
  let answer: unknown = { status: 'waiting' };
  const t = setup({ reportProximity: () => answer });
  await t.fit.start();
  t.near();
  await t.advance(500);
  // No more observations: the counterpart already matched and stopped its BLE radio.
  await t.advance(3000);
  expect(t.fit.snapshot().stage).toBe('searching');
  answer = { status: 'matched', sessionId: 's1' };
  t.pushView({
    sessionId: 's1',
    stage: 'matched',
    reason: null,
    boardId: null,
    boardChanged: false,
  });
  await t.advance(1000);
  expect(t.fit.snapshot().stage).toBe('preview');
  expect(
    t.calls
      .filter((c) => c.name === 'reportProximity')
      .every(
        (c) =>
          JSON.stringify(c.data) ===
          JSON.stringify({ token: TOKEN, peerToken: PEER, method: 'ble' }),
      ),
  ).toBe(true);
});
test('multiple candidates pause even an existing waiting claim', async () => {
  const t = setup({ reportProximity: () => ({ status: 'waiting' }) });
  await t.fit.start();
  t.near();
  await t.advance(500);
  const reports = t.names().filter((name) => name === 'reportProximity').length;
  t.other();
  t.near();
  await t.advance(500);
  expect(t.fit.snapshot().stage).toBe('multiple');
  expect(t.names().filter((name) => name === 'reportProximity')).toHaveLength(
    reports,
  );
});

test('a stopped run with an unresolved report does not block a new scan', async () => {
  let first = true;
  const t = setup({
    reportProximity: () => {
      if (first) {
        first = false;
        return new Promise(() => {});
      }
      return { status: 'matched', sessionId: 's1' };
    },
  });
  await t.fit.start();
  t.near();
  await t.advance(500);
  await t.fit.leave();
  await t.fit.start();
  t.near();
  await t.advance(500);
  expect(t.fit.snapshot().stage).toBe('preview');
});
