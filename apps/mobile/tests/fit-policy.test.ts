import { receiveCorrection } from '../src/fit/calibration';
import { DEFAULT_POLICY, judge, type Observation } from '../src/fit/policy';

const T = 'A'.repeat(22);
function run(
  deviceId: string,
  rssi: number,
  from: number,
  to: number,
  extra: Partial<Observation> = {},
): Observation[] {
  const out: Observation[] = [];
  for (let at = from; at <= to; at += 250)
    out.push({
      deviceId,
      token: T,
      rssi,
      distanceMeters: null,
      atMs: at,
      ...extra,
    });
  return out;
}

test('one device held near for the whole hold time is near, with its token', () => {
  expect(judge(run('a', -40, 1250, 3000), 3000)).toEqual({
    status: 'near',
    peerToken: T,
    method: 'ble',
  });
});
test('a shorter hold, a weak window or a vanished device is not near', () => {
  expect(judge(run('a', -40, 2000, 3000), 3000).status).toBe('searching');
  const dip = [...run('a', -40, 1250, 1999), ...run('a', -60, 2000, 3000)];
  expect(judge(dip, 3000).status).toBe('searching');
  expect(judge(run('a', -40, 1250, 1750), 3000).status).toBe('searching');
  expect(judge([], 3000).status).toBe('searching');
});
test('thresholds are inclusive and corrected by the device offset', () => {
  expect(DEFAULT_POLICY.nearRssi).toBe(-48);
  expect(judge(run('a', -48, 1250, 3000), 3000).status).toBe('near');
  expect(judge(run('a', -49, 1250, 3000), 3000).status).toBe('searching');
  expect(judge(run('a', -58, 1250, 3000), 3000, () => 10).status).toBe('near');
});
test('the measured iPhone 16 correction applies only to Android peers', () => {
  const iphone16 = receiveCorrection('iPhone17,3');
  // Side-by-side 10 cm: the iPhone received about −60 dBm (minimum −63).
  const fromAndroid = run('a', -63, 1250, 3000, { peerPlatform: 'android' });
  expect(judge(fromAndroid, 3000, iphone16).status).toBe('near');
  // Back-to-back 50 cm: at most −67.5 dBm, which must stay below the threshold.
  const far = run('a', -67, 1250, 3000, { peerPlatform: 'android' });
  expect(judge(far, 3000, iphone16).status).toBe('searching');
  // Unmeasured pairs fall back to no correction: harder to start, never easier.
  for (const extra of [
    { peerPlatform: 'ios' as const },
    { peerPlatform: null },
    {},
  ])
    expect(judge(run('a', -63, 1250, 3000, extra), 3000, iphone16).status).toBe(
      'searching',
    );
  for (const model of ['PDRM00', 'iPhone16,1', '', null, 'constructor'])
    expect(judge(fromAndroid, 3000, receiveCorrection(model)).status).toBe(
      'searching',
    );
});
test('presence uses the corrected value, so a corrected far peer still blocks', () => {
  const iphone16 = receiveCorrection('iPhone17,3');
  const near = run('a', -55, 1250, 3000, { peerPlatform: 'android' });
  // Side-by-side 100 cm read about −78.5 dBm on the iPhone: −61.5 after correction.
  const third = run('b', -79, 2250, 3000, { peerPlatform: 'android' });
  expect(judge([...near, ...third], 3000, iphone16).status).toBe('multiple');
  expect(judge([...near, ...third], 3000).status).toBe('searching');
});
test('a second device above the presence threshold blocks, a faint one does not', () => {
  const near = run('a', -40, 1250, 3000);
  expect(judge([...near, ...run('b', -70, 2250, 3000)], 3000).status).toBe(
    'multiple',
  );
  expect(judge([...near, ...run('b', -71, 2250, 3000)], 3000).status).toBe(
    'near',
  );
  expect(
    judge([...run('a', -60, 1250, 3000), ...run('b', -60, 2250, 3000)], 3000)
      .status,
  ).toBe('multiple');
});
test('a device without a readable token is not reported', () => {
  expect(judge(run('a', -40, 1250, 3000, { token: null }), 3000).status).toBe(
    'searching',
  );
  const late = [
    ...run('a', -40, 1250, 2000, { token: null }),
    ...run('a', -40, 2250, 3000),
  ];
  expect(judge(late, 3000)).toMatchObject({ status: 'near', peerToken: T });
});
test('UWB ranging overrides BLE strength in both directions', () => {
  const far = run('a', -30, 1250, 3000, { distanceMeters: 0.4 });
  expect(judge(far, 3000).status).toBe('searching');
  const close = run('a', -60, 1250, 3000, { distanceMeters: 0.1 });
  expect(judge(close, 3000)).toMatchObject({ status: 'near', method: 'uwb' });
  expect(
    judge(run('a', -40, 1250, 3000, { distanceMeters: 0.15 }), 3000).status,
  ).toBe('near');
  expect(DEFAULT_POLICY.uwbNearMeters).toBe(0.15);
});

test('a latest unread token revokes an older token without hiding a second device', () => {
  const samples = [
    ...run('a', -40, 1250, 2750),
    ...run('a', -40, 3000, 3000, { token: null }),
  ];
  expect(judge(samples, 3000).status).toBe('searching');
  expect(
    judge([...samples, ...run('b', -40, 2500, 3000, { token: null })], 3000)
      .status,
  ).toBe('multiple');
  expect(
    judge(
      [...samples, ...run('a', -40, 3000, 3000, { token: 'B'.repeat(22) })],
      3000,
    ),
  ).toMatchObject({ status: 'near', peerToken: 'B'.repeat(22) });
});

test('timestamp order wins over callback arrival, with the last arrival breaking ties', () => {
  const near = run('a', -40, 1250, 3000);
  expect(
    judge([...near, ...run('a', -40, 2800, 2800, { token: null })], 3000)
      .status,
  ).toBe('near');
  expect(
    judge([...near, ...run('a', -40, 3000, 3000, { token: null })], 3000)
      .status,
  ).toBe('searching');
  expect(judge([...near].reverse(), 3000).status).toBe('near');
});
