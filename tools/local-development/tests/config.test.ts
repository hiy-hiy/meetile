import {
  appMode,
  assertLocalServer,
  isLocalHost,
  localDeviceSchema,
  LOCAL_PROJECT,
} from '../config';

test('only selects local mode explicitly and in development', () => {
  expect(appMode(undefined, 'staging')).toBe('cloud');
  expect(appMode('local', 'development')).toBe('local');
  expect(() => appMode('local', 'staging')).toThrow();
  expect(() => appMode('typo', 'development')).toThrow();
});
test('accepts private IPv4 and loopback, rejects public addresses and URL injection', () => {
  for (const host of [
    '127.0.0.1',
    '10.0.0.2',
    '172.16.1.2',
    '172.31.255.254',
    '192.168.1.2',
  ])
    expect(isLocalHost(host)).toBe(true);
  for (const host of [
    '8.8.8.8',
    '172.15.1.2',
    '172.32.0.1',
    '192.168.0.256',
    '192.168.01.2',
    'localhost',
    '::1',
    'http://192.168.0.1',
    '192.168.0.1:8080',
    '192.168.0.1/other',
    '',
  ])
    expect(isLocalHost(host)).toBe(false);
});
test('never accepts an actual project or incomplete settings', () => {
  const settings = {
    mode: 'local',
    projectId: LOCAL_PROJECT,
    host: '192.168.0.1',
    iosServices: 'local.plist',
    androidServices: 'local.json',
  };
  expect(localDeviceSchema.parse(settings)).toEqual(settings);
  expect(
    localDeviceSchema.safeParse({ ...settings, projectId: 'real-project' })
      .success,
  ).toBe(false);
  expect(
    localDeviceSchema.safeParse({ ...settings, host: undefined }).success,
  ).toBe(false);
});
test('connection server requires emulator, demo project, explicit mode and fresh run identity', () => {
  const environment = {
    FUNCTIONS_EMULATOR: 'true',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
    GCLOUD_PROJECT: LOCAL_PROJECT,
    PUZZLE_LOCAL_MODE: 'session-v2',
    PUZZLE_LOCAL_RUN_ID: 'e54f47e8-0d7a-4d70-b1c0-d469ff950f05',
  };
  expect(() => assertLocalServer(environment)).not.toThrow();
  for (const key of Object.keys(environment))
    expect(() =>
      assertLocalServer({ ...environment, [key]: undefined }),
    ).toThrow();
  expect(() =>
    assertLocalServer({ ...environment, GCLOUD_PROJECT: 'real-project' }),
  ).toThrow();
});
