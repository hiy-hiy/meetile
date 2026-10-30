import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { summarizeProximity } from '../proximity-report.mjs';

const template = JSON.parse(
  await readFile(
    new URL(
      '../../docs/fixtures/proximity-session.template.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const fresh = () => JSON.parse(JSON.stringify(template));
function measurement() {
  const value = fresh();
  value.criteria.status = 'approved';
  value.build = {
    label: 'TEST-ONLY',
    sourceSha256: 'a'.repeat(64),
    nativeModeConfirmed: true,
  };
  return value;
}
const preview = (number, peer = 'intended', merge = 'not-attempted') => ({
  number,
  outcome: 'preview',
  peer,
  elapsedMs: 3000,
  methods: ['ble', 'ble'],
  multipleDetected: false,
  merge,
});
const timeout = (number) => ({
  number,
  outcome: 'timeout',
  peer: null,
  elapsedMs: null,
  methods: null,
  multipleDetected: false,
  merge: 'not-attempted',
});

test('the committed template stays unmeasured and cannot issue an acceptance decision', () => {
  const result = summarizeProximity(fresh());
  assert.equal(result.acceptance, 'not-evaluated');
  assert.equal(result.criteriaStatus, 'proposed');
  assert.equal(result.series[0].remaining, 20);
  assert.equal(result.series[0].complete, false);
  assert.equal(result.series[0].anyPreviewRate, null);
});

test('separates intended preview, unintended peer, timeout, and shape incompatibility', () => {
  const value = measurement();
  value.series[0].trials = Array.from({ length: 18 }, (_, index) =>
    preview(index + 1, 'intended', index === 0 ? 'no-fit' : 'not-attempted'),
  );
  value.series[0].trials.push(preview(19, 'unexpected'), timeout(20));
  const result = summarizeProximity(value);
  assert.equal(result.acceptance, 'not-evaluated');
  assert.deepEqual(result.series[0], {
    id: 'S01',
    planned: 20,
    recorded: 20,
    remaining: 0,
    aborted: 0,
    complete: true,
    methodsConfirmed: true,
    intendedPreviews: 18,
    oneSidedPreviews: 0,
    unexpectedPreviews: 1,
    timeouts: 1,
    multipleDetections: 0,
    intendedPreviewRate: 0.9,
    anyPreviewRate: 0.95,
    maxIntendedPreviewMs: 3000,
    merged: 0,
    noFit: 1,
  });
});

test('keeps partial and aborted rates unset and flags unknown methods', () => {
  const value = measurement();
  value.series[0].trials = [preview(1)];
  assert.equal(summarizeProximity(value).series[0].intendedPreviewRate, null);
  value.series[0].trials = Array.from({ length: 20 }, (_, index) =>
    timeout(index + 1),
  );
  value.series[0].trials[19].outcome = 'aborted';
  const result = summarizeProximity(value).series[0];
  assert.equal(result.aborted, 1);
  assert.equal(result.complete, false);
  assert.equal(result.anyPreviewRate, null);
  value.series[0].trials = Array.from({ length: 20 }, (_, index) =>
    preview(index + 1),
  );
  value.series[0].trials[0].methods = ['unknown', 'ble'];
  assert.equal(summarizeProximity(value).series[0].methodsConfirmed, false);
});

test('refuses simulated evidence, missing build proof and pre-decision physical measurements', () => {
  for (const mutate of [
    (value) => {
      value.evidence = 'simulated';
    },
    (value) => {
      value.build.sourceSha256 = null;
    },
    (value) => {
      value.build.nativeModeConfirmed = false;
    },
    (value) => {
      value.criteria.status = 'proposed';
    },
  ]) {
    const value = measurement();
    value.series[0].trials = [preview(1)];
    mutate(value);
    assert.throws(() => summarizeProximity(value));
  }
});

test('rejects duplicate trials/devices/series, missing participants and invalid denominators', () => {
  for (const mutate of [
    (value) => {
      value.devices[1].id = 'D1';
    },
    (value) => {
      value.series.push(value.series[0]);
    },
    (value) => {
      value.series[0].deviceIds = ['D1', 'D1'];
    },
    (value) => {
      value.series[0].deviceIds[1] = 'D9';
    },
    (value) => {
      value.series[0].plannedTrials = 19;
    },
    (value) => {
      value.series[0].trials = [preview(2)];
    },
    (value) => {
      value.series[0].trials = [preview(1), preview(1)];
    },
    (value) => {
      value.series[0].trials = Array.from({ length: 21 }, (_, index) =>
        timeout(index + 1),
      );
    },
  ]) {
    const value = measurement();
    mutate(value);
    assert.throws(() => summarizeProximity(value));
  }
});

test('validates preview timing, non-preview claims and UWB capability without inventing methods', () => {
  for (const mutate of [
    (entry) => {
      entry.elapsedMs = 10001;
    },
    (entry) => {
      entry.elapsedMs = -1;
    },
    (entry) => {
      entry.elapsedMs = null;
    },
    (entry) => {
      entry.peer = null;
    },
    (entry) => {
      entry.outcome = 'timeout';
    },
    (entry) => {
      entry.methods = ['uwb', 'uwb'];
    },
    (entry) => {
      entry.methods = null;
    },
  ]) {
    const value = measurement();
    const entry = preview(1);
    mutate(entry);
    value.series[0].trials = [entry];
    assert.throws(() => summarizeProximity(value));
  }
});

test('three-device series requires the real third participant and records any preview as a trigger', () => {
  const value = measurement();
  const item = value.series[0];
  item.kind = 'multiple';
  assert.throws(() => summarizeProximity(value));
  item.deviceIds.push('D3');
  item.thirdDistanceCm = 30;
  value.devices.push({ ...value.devices[1], id: 'D3' });
  item.trials = Array.from({ length: 20 }, (_, index) => ({
    ...timeout(index + 1),
    multipleDetected: true,
  }));
  item.trials[0] = preview(1);
  const result = summarizeProximity(value).series[0];
  assert.equal(result.anyPreviewRate, 0.05);
  assert.equal(result.multipleDetections, 19);
});

test('a one-sided preview remains a safety trigger without counting as intended bilateral success', () => {
  const value = measurement();
  value.series[0].distanceCm = 50;
  value.series[0].trials = Array.from({ length: 20 }, (_, index) =>
    timeout(index + 1),
  );
  value.series[0].trials[0] = {
    ...preview(1, 'unexpected'),
    outcome: 'one-sided',
  };
  const result = summarizeProximity(value).series[0];
  assert.equal(result.intendedPreviews, 0);
  assert.equal(result.oneSidedPreviews, 1);
  assert.equal(result.unexpectedPreviews, 1);
  assert.equal(result.anyPreviewRate, 0.05);
  value.series[0].trials[0].merge = 'merged';
  assert.throws(() => summarizeProximity(value));
});

test('unknown private fields are rejected; CLI errors never echo private input or file paths', async () => {
  const value = measurement();
  value.series[0].trials = [
    { ...preview(1), safetyId: 'private-fixture-value' },
  ];
  assert.throws(() => summarizeProximity(value));
  const script = new URL('../proximity-report.mjs', import.meta.url);
  const root = await mkdtemp(join(tmpdir(), 'proximity-report-'));
  try {
    const file = join(root, 'private-fixture-value.json');
    await writeFile(file, JSON.stringify(value));
    for (const path of [
      file,
      join(root, 'private-fixture-value-not-present.json'),
    ]) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(script), path],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(
        result.stderr,
        /private-fixture-value|ENOENT|ZodError/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
