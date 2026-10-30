import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { adminLocalEnvironment, createAdminFixture } from './admin-fixture.mjs';
import { localHealthSchema } from '../tools/local-development/config.ts';
import { assertRuntimeDirectory } from './local-control.mjs';
if (process.argv.length !== 2)
  throw new Error('Usage: pnpm local:admin-fixture');
const root = resolve('.tools/local-runtime');
await assertRuntimeDirectory(root);
const identity = JSON.parse(
  await readFile(`${root}/server-identity.json`, 'utf8'),
);
const probe = randomUUID();
const response = await fetch(
  `http://127.0.0.1:15001/demo-puzzle-sns-local/asia-northeast1/localHealth?probe=${probe}`,
  { signal: AbortSignal.timeout(8000) },
);
const health = localHealthSchema.parse(await response.json());
if (!response.ok || health.runId !== identity || health.probe !== probe)
  throw new Error('Matching local server required');
Object.assign(process.env, adminLocalEnvironment(identity));
for (const key of [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_TOKEN',
  'FIREBASE_CONFIG',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
])
  delete process.env[key];
const app = initializeApp(
  {
    projectId: 'demo-puzzle-sns-local',
  },
  randomUUID(),
);
try {
  const cases = await Promise.all(
    ['A', 'B'].map((label) => createAdminFixture(app, label)),
  );
  await writeFile(
    `${root}/admin-fixture.json`,
    JSON.stringify({ runId: identity, cases }) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Created two independent artificial reports for admin review. Existing app photos were not changed.',
  );
} finally {
  await deleteApp(app);
}
