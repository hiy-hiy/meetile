import {
  observedSource,
  ProximityDiagnostics,
} from '../src/local/proximity-observation';
import type { Observation } from '../src/fit/policy';
import type { ProximitySource, UnavailableKind } from '../src/fit/source';

const value: Observation = {
  deviceId: 'private-peer',
  token: 'AAAAAAAAAAAAAAAAAAAAAA',
  rssi: -40,
  distanceMeters: null,
  atMs: 1000,
};
function setup() {
  let now = 1000;
  const store = new ProximityDiagnostics(() => now);
  let observe: (value: Observation) => void = () => {};
  let fail: (kind: UnavailableKind) => void = () => {};
  let finish: (done: boolean) => void = () => {};
  const source: ProximitySource = {
    start: jest.fn(async (_token, seen, unavailable) => {
      observe = seen;
      fail = unavailable;
    }),
    stop: jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const wrapped = observedSource(source, 'native', store);
  const received = jest.fn();
  const unavailable = jest.fn();
  return {
    store,
    source,
    wrapped,
    received,
    unavailable,
    start: () => wrapped.start('own-private-token', received, unavailable),
    emit: (v: Observation) => observe(v),
    fail: (kind: UnavailableKind) => fail(kind),
    finish: (done: boolean) => finish(done),
    time: (v: number) => {
      now = v;
    },
  };
}

test('only coarse method and lifecycle reach the snapshot; product observations are forwarded unchanged', async () => {
  const t = setup();
  await t.start();
  expect(t.store.snapshot().activity).toBe('starting');
  t.emit(value);
  expect(t.received).toHaveBeenCalledWith(value);
  expect(t.store.snapshot()).toEqual({
    input: 'native',
    activity: 'observing',
    method: 'ble',
    reason: null,
  });
  const serialized = JSON.stringify(t.store.snapshot());
  for (const privateValue of [
    'private-peer',
    value.token!,
    'rssi',
    'distanceMeters',
    'atMs',
    'own-private-token',
  ])
    expect(serialized).not.toContain(privateValue);
  t.emit({ ...value, token: null });
  expect(t.store.snapshot().method).toBe('pending');
  t.emit({ ...value, distanceMeters: 0.5 });
  expect(t.store.snapshot().method).toBe('uwb');
});
test('stale, future and out-of-order samples cannot certify the current method', async () => {
  const t = setup();
  await t.start();
  t.emit(value);
  t.emit({ ...value, atMs: 1001, distanceMeters: 0.1 });
  expect(t.store.snapshot().method).toBe('ble');
  t.time(1100);
  t.emit({ ...value, atMs: 1100, distanceMeters: 0.5 });
  t.emit(value);
  expect(t.store.snapshot().method).toBe('uwb');
  t.time(2101);
  t.store.refresh();
  expect(t.store.snapshot().method).toBe('stale');
  t.emit(value);
  expect(t.store.snapshot().method).toBe('stale');
});
test('stop request is distinct from native response, and delayed measurements are fenced immediately', async () => {
  const t = setup();
  await t.start();
  t.emit(value);
  const pending = t.wrapped.stop();
  expect(t.store.snapshot().activity).toBe('stopping');
  t.emit(value);
  expect(t.received).toHaveBeenCalledTimes(1);
  t.finish(true);
  await pending;
  expect(t.store.snapshot().activity).toBe('stopped');
  expect(t.store.snapshot().method).toBe('none');
});
test('failed or missing native acknowledgement does not become completed', async () => {
  const t = setup();
  await t.start();
  const stop = t.wrapped.stop();
  t.finish(false);
  await stop;
  expect(t.store.snapshot().activity).toBe('unconfirmed');
  t.source.stop = () => {
    throw new Error('private-native-error');
  };
  await t.wrapped.stop();
  expect(t.store.snapshot().activity).toBe('unconfirmed');
});
test('a previous stop response cannot overwrite a newer attempt', async () => {
  const t = setup();
  await t.start();
  const stop = t.wrapped.stop();
  await t.start();
  t.emit(value);
  t.finish(true);
  await stop;
  expect(t.store.snapshot().activity).toBe('observing');
});
test('unavailable callbacks keep only the known reason and cannot revive a stopped source', async () => {
  const t = setup();
  await t.start();
  t.fail('interrupted');
  expect(t.unavailable).toHaveBeenCalledWith('interrupted');
  expect(t.store.snapshot().reason).toBe('interrupted');
  t.emit(value);
  expect(t.received).not.toHaveBeenCalled();
  const stopped = t.wrapped.stop();
  t.finish(true);
  await stopped;
  expect(t.store.snapshot().activity).toBe('unavailable');
});
test('simulated input and its stop response stay explicitly distinct from native radio', async () => {
  const store = new ProximityDiagnostics();
  const source: ProximitySource = {
    start: jest.fn(async () => {}),
    stop: jest.fn(),
  };
  const wrapped = observedSource(source, 'simulated', store);
  await wrapped.start(
    'test-token',
    () => {},
    () => {},
  );
  await wrapped.stop();
  expect(store.snapshot()).toMatchObject({
    input: 'simulated',
    activity: 'stopped',
    method: 'none',
  });
});

test('the wrapper keeps the radio correction used by the near judgement', () => {
  const correction = () => 17;
  const store = new ProximityDiagnostics();
  const wrapped = observedSource(
    { start: async () => {}, stop: () => {}, correction },
    'native',
    store,
  );
  expect(wrapped.correction).toBe(correction);
});
