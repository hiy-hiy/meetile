import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  LOCAL_PROJECT,
  LOCAL_PORTS,
  LOCAL_REGION,
  localScenarioSchema,
  localHealthSchema,
} from '../tools/local-development/config.ts';
import { requestLocalReset } from './local-control.mjs';

const args = process.argv.slice(2).filter((value) => value !== '--');
if (args.length && !(args.length === 2 && args[0] === '--scenario'))
  throw new Error(
    'Usage: pnpm local:reset [--scenario approved|rejected|held|error-once]',
  );
const scenario = args.length ? localScenarioSchema.parse(args[1]) : undefined;
const root = resolve('.tools/local-runtime');
const runId = z
  .uuid()
  .parse(JSON.parse(await readFile(`${root}/server-identity.json`, 'utf8')));
console.log(
  'Resetting only this running demo environment: stopping emulators, removing local test data, then restarting.',
);
let next;
try {
  next = await requestLocalReset(root, {
    action: 'reset',
    projectId: LOCAL_PROJECT,
    runId,
    ...(scenario ? { scenario } : {}),
  });
} catch {
  throw new Error(
    'Local reset failed. Start pnpm local:server from this workspace and retry; no other process was stopped.',
  );
}
const deadline = Date.now() + 120000;
let ready = false;
while (Date.now() < deadline) {
  const probe = randomUUID();
  try {
    const response = await fetch(
      `http://127.0.0.1:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}/localHealth?probe=${probe}`,
      { signal: AbortSignal.timeout(3000), redirect: 'error' },
    );
    const health = localHealthSchema.parse(await response.json());
    if (response.ok && health.runId === next && health.probe === probe) {
      ready = true;
      break;
    }
  } catch {
    /* Wait for the restarted local Functions endpoint. */
  }
  await setTimeout(1000);
}
if (!ready)
  throw new Error(
    'Data was reset, but startup is not ready. Check the local server terminal.',
  );
console.log(
  'Local reset complete. In the iPhone app, tap reconnect (or reopen it); age and internal-test acknowledgement will be requested again.',
);
