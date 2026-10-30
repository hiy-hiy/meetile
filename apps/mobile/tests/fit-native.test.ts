import {
  NativeProximity,
  SERVICE_UUIDS,
  type NativeProximityModule,
} from '../src/fit/native';
import type { Observation } from '../src/fit/policy';

function setup() {
  const callbacks: Record<string, ((value: unknown) => void)[]> = {};
  const remove = jest.fn();
  let lastRun = '';
  const module: NativeProximityModule = {
    start: jest.fn(async (_token, _service, id) => {
      lastRun = id;
    }),
    stop: jest.fn(async () => {}),
    addListener: (event, callback) => {
      (callbacks[event] ??= []).push(callback);
      return { remove };
    },
  };
  let nextRun = 0;
  const source = new NativeProximity(
    module,
    SERVICE_UUIDS.local,
    () => `test-${++nextRun}`,
  );
  const seen: Observation[] = [];
  const unavailable = jest.fn();
  const start = async () => {
    await source.start(
      'AAAAAAAAAAAAAAAAAAAAAA',
      (v) => seen.push(v),
      unavailable,
    );
    return lastRun;
  };
  const emit = (event: string, value: unknown) =>
    callbacks[event]?.forEach((c) => c(value));
  return { source, module, seen, unavailable, start, emit, remove };
}
const sample = {
  deviceId: 'ephemeral-handle',
  token: 'AAAAAAAAAAAAAAAAAAAAAA',
  rssi: -40,
  distanceMeters: 0.1,
  atMs: 1000,
};
test('the peer OS class is forwarded only with a readable token, and selects the local correction', async () => {
  const t = setup();
  const runId = await t.start();
  t.emit('observation', { ...sample, runId, peerPlatform: 'android' });
  t.emit('observation', {
    ...sample,
    runId,
    token: null,
    peerPlatform: 'android',
  });
  t.emit('observation', { ...sample, runId, peerPlatform: null });
  t.emit('observation', { ...sample, runId, peerPlatform: 'windows' });
  expect(t.seen).toEqual([
    { ...sample, peerPlatform: 'android' },
    { ...sample, token: null },
    sample,
  ]);
  expect(t.source.correction(t.seen[0]!)).toBe(0); // No model exported.
  const iphone = new NativeProximity(
    { ...t.module, model: 'iPhone17,3' },
    SERVICE_UUIDS.local,
  );
  expect(iphone.correction(t.seen[0]!)).toBe(17);
  expect(iphone.correction(t.seen[1]!)).toBe(0);
});
test('native observations reach the policy without the transport run ID', async () => {
  const t = setup();
  const runId = await t.start();
  t.emit('observation', { ...sample, runId });
  expect(t.seen).toEqual([sample]);
  expect(t.module.start).toHaveBeenCalledWith(
    sample.token,
    SERVICE_UUIDS.local,
    runId,
  );
});
test('stopped or replaced scans reject delayed callbacks and stop only their own run', async () => {
  const t = setup();
  const old = await t.start();
  const current = await t.start();
  t.emit('observation', { ...sample, runId: old });
  t.emit('unavailable', { runId: old, kind: 'bluetooth-off' });
  expect(t.seen).toEqual([]);
  expect(t.unavailable).not.toHaveBeenCalled();
  t.emit('observation', {
    ...sample,
    runId: current,
    token: null,
    distanceMeters: null,
  });
  expect(t.seen).toHaveLength(1); // Unread peers must still count toward multiple-device detection.
  void t.source.stop();
  t.emit('observation', { ...sample, runId: current });
  expect(t.seen).toHaveLength(1);
  expect(t.module.stop).toHaveBeenCalledWith(old);
  expect(t.module.stop).toHaveBeenCalledWith(current);
  expect(t.remove).toHaveBeenCalledTimes(4);
});
test('invalid RSSI, distance, token and time are rejected at the native boundary', async () => {
  const t = setup();
  const runId = await t.start();
  for (const bad of [
    { rssi: 127 },
    { distanceMeters: -1 },
    { distanceMeters: Infinity },
    { token: 'wrong' },
    { atMs: NaN },
    { deviceId: '' },
  ])
    t.emit('observation', { ...sample, runId, ...bad });
  expect(t.seen).toEqual([]);
});
test.each(['permission', 'bluetooth-off', 'unsupported', 'interrupted'])(
  'native %s ends the source',
  async (kind) => {
    const t = setup();
    const runId = await t.start();
    t.emit('unavailable', { runId, kind });
    t.emit('observation', { ...sample, runId });
    expect(t.unavailable).toHaveBeenCalledWith(kind);
    expect(t.seen).toEqual([]);
    expect(t.module.stop).toHaveBeenCalledWith(runId);
  },
);
test('native startup rejection is handled, while rejection from a stopped run is ignored', async () => {
  const t = setup();
  t.module.start = jest.fn(async () => {
    throw new Error('missing radio');
  });
  await t.start();
  expect(t.unavailable).toHaveBeenCalledWith('unsupported');
  let reject: (error: Error) => void = () => {};
  t.module.start = jest.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  t.unavailable.mockClear();
  const pending = t.start();
  void t.source.stop();
  reject(new Error('late'));
  await pending;
  expect(t.unavailable).not.toHaveBeenCalled();
});

test('native stop acknowledges completion or failure and repeated stop preserves that result', async () => {
  const t = setup();
  await t.start();
  let finish: () => void = () => {};
  t.module.stop = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = t.source.stop();
  expect(t.source.stop()).toBe(pending);
  finish();
  expect(await pending).toBe(true);
  await t.start();
  t.module.stop = jest.fn(async () => {
    throw new Error('teardown failed');
  });
  expect(await t.source.stop()).toBe(false);
  expect(await t.source.stop()).toBe(false);
});
