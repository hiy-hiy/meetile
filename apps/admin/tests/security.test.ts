import { readAdminConfig } from '../src/server/config';
import { assertRequestOrigin, readJson } from '../src/server/http';

const local = {
  PUZZLE_ADMIN_MODE: 'local',
  PUZZLE_ADMIN_PROJECT_ID: 'demo-puzzle-sns-local',
  PUZZLE_ADMIN_BUCKET: 'demo-puzzle-sns-local.appspot.com',
  GCLOUD_PROJECT: 'demo-puzzle-sns-local',
  PUZZLE_ADMIN_ORIGIN: 'http://127.0.0.1:3002',
  PUZZLE_LOCAL_RUN_ID: '11111111-1111-4111-8111-111111111111',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
  STORAGE_EMULATOR_HOST: 'http://127.0.0.1:19199',
};
test('admin configuration stays closed by default and local mode cannot target live services or a LAN listener', () => {
  expect(() => readAdminConfig({})).toThrow();
  expect(readAdminConfig(local).mode).toBe('local');
  for (const patch of [
    { PUZZLE_ADMIN_PROJECT_ID: 'real-project' },
    { FIRESTORE_EMULATOR_HOST: '192.168.1.2:18080' },
    { PUZZLE_ADMIN_ORIGIN: 'http://0.0.0.0:3002' },
    { PUZZLE_ADMIN_BUCKET: 'real-project.appspot.com' },
    { PUZZLE_LOCAL_RUN_ID: 'invalid' },
    { FIREBASE_AUTH_EMULATOR_HOST: '' },
  ])
    expect(() => readAdminConfig({ ...local, ...patch })).toThrow();
});
test('cloud mode requires matching project, bucket, HTTPS origin and public web registration, and rejects all emulator routing', () => {
  const cloud = {
    PUZZLE_ADMIN_MODE: 'cloud',
    PUZZLE_ADMIN_PROJECT_ID: 'synthetic-staging',
    GCLOUD_PROJECT: 'synthetic-staging',
    PUZZLE_ADMIN_BUCKET: 'synthetic-staging.appspot.com',
    PUZZLE_ADMIN_ORIGIN: 'https://admin.example.invalid',
    PUZZLE_ADMIN_FIREBASE_WEB: JSON.stringify({
      apiKey: 'synthetic',
      authDomain: 'synthetic-staging.firebaseapp.com',
      projectId: 'synthetic-staging',
      appId: 'synthetic',
    }),
  };
  expect(readAdminConfig(cloud).mode).toBe('cloud');
  for (const patch of [
    { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099' },
    { PUZZLE_ADMIN_ORIGIN: 'http://admin.example.invalid' },
    { GCLOUD_PROJECT: 'other-project' },
    { PUZZLE_ADMIN_BUCKET: 'other.appspot.com' },
    { PUZZLE_ADMIN_ORIGIN: 'https://admin.example.invalid/path' },
  ])
    expect(() => readAdminConfig({ ...cloud, ...patch })).toThrow();
});
test('all requests pin the expected host; mutations also require same-origin and the non-simple header', () => {
  const config = readAdminConfig(local),
    url = config.origin + '/api/admin';
  expect(() =>
    assertRequestOrigin(
      new Request(url, { headers: { host: '127.0.0.1:3002' } }),
      config,
    ),
  ).not.toThrow();
  expect(() =>
    assertRequestOrigin(
      new Request('http://localhost:3002/api/admin', {
        headers: { host: '127.0.0.1:3002' },
      }),
      config,
    ),
  ).not.toThrow();
  for (const headers of [
    { host: 'attacker.invalid' },
    { host: '127.0.0.1:3002', 'sec-fetch-site': 'cross-site' },
  ])
    expect(() =>
      assertRequestOrigin(new Request(url, { headers }), config),
    ).toThrow();
  expect(() =>
    assertRequestOrigin(
      new Request(url, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3002',
          origin: config.origin,
          'x-puzzle-admin': '1',
        },
      }),
      config,
    ),
  ).not.toThrow();
  for (const headers of [
    {
      host: '127.0.0.1:3002',
      origin: 'https://attacker.invalid',
      'x-puzzle-admin': '1',
    },
    { host: '127.0.0.1:3002', origin: config.origin },
  ])
    expect(() =>
      assertRequestOrigin(
        new Request(url, { method: 'POST', headers }),
        config,
      ),
    ).toThrow();
});
test('admin JSON requests reject forms and oversized streamed content', async () => {
  await expect(
    readJson(
      new Request('http://127.0.0.1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      }),
    ),
  ).resolves.toEqual({ a: 1 });
  await expect(
    readJson(
      new Request('http://127.0.0.1', { method: 'POST', body: 'form=1' }),
    ),
  ).rejects.toThrow();
  await expect(
    readJson(
      new Request('http://127.0.0.1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(8200) }),
      }),
    ),
  ).rejects.toThrow();
});
