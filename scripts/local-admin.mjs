import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import {
  adminLocalEnvironment,
  prepareLocalOperator,
} from './admin-fixture.mjs';
import { localHealthSchema } from '../tools/local-development/config.ts';
import { assertRuntimeDirectory } from './local-control.mjs';

if (process.argv.length !== 2) throw new Error('Usage: pnpm admin:local');
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
const environment = adminLocalEnvironment(identity);
Object.assign(process.env, environment);
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
  'local-admin-setup-' +
    createHash('sha256').update(identity).digest('hex').slice(0, 8),
);
try {
  await prepareLocalOperator(app);
} finally {
  await deleteApp(app);
}
const next = createRequire(resolve('apps/admin/package.json')).resolve(
  'next/dist/bin/next',
);
const child = spawn(
  process.execPath,
  [next, 'start', '--hostname', '127.0.0.1', '--port', '3002'],
  { cwd: resolve('apps/admin'), env: environment, stdio: 'inherit' },
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => child.kill(signal));
console.log(
  'Local admin: http://127.0.0.1:3002 — synthetic operator only; no cloud hosting or billing changes.',
);
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
