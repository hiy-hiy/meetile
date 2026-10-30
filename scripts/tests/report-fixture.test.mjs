import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createReportFixture } from '../report-fixture.mjs';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
} from '../../tools/local-development/config.ts';

test('report fixture refuses real projects, wrong buckets and remote emulator hosts before accessing data', async () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, {
      GCLOUD_PROJECT: LOCAL_PROJECT,
      PUZZLE_LOCAL_MODE: 'session-v2',
      PUZZLE_LOCAL_RUN_ID: randomUUID(),
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:19099',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
      FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:19199',
    });
    await assert.rejects(
      createReportFixture(
        { projectId: 'production' },
        { name: LOCAL_BUCKET },
        'synthetic-a',
        'synthetic-b',
      ),
    );
    await assert.rejects(
      createReportFixture(
        { projectId: LOCAL_PROJECT },
        { name: 'production-bucket' },
        'synthetic-a',
        'synthetic-b',
      ),
    );
    process.env.FIRESTORE_EMULATOR_HOST = '8.8.8.8:18080';
    await assert.rejects(
      createReportFixture(
        { projectId: LOCAL_PROJECT },
        { name: LOCAL_BUCKET },
        'synthetic-a',
        'synthetic-b',
      ),
    );
  } finally {
    for (const name of Object.keys(process.env))
      if (!(name in before)) delete process.env[name];
    Object.assign(process.env, before);
  }
});
