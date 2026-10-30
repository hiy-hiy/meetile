import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

// Offline development records only. Never import this module into the application.
const alias = z.string().regex(/^[A-Z][A-Z0-9-]{0,23}$/);
const device = z.strictObject({
  id: alias,
  platform: z.enum(['ios', 'android']),
  model: z.string().min(1).max(64),
  osVersion: z.string().min(1).max(24),
  availability: z.enum(['connected', 'unavailable', 'not-provided']),
  uwbCapability: z.enum(['available', 'unavailable', 'unknown']),
});
const trial = z.strictObject({
  number: z.number().int().min(1).max(1000),
  outcome: z.enum(['preview', 'one-sided', 'timeout', 'aborted']),
  peer: z.enum(['intended', 'unexpected']).nullable(),
  elapsedMs: z.number().int().min(0).max(60000).nullable(),
  methods: z
    .tuple([
      z.enum(['ble', 'uwb', 'unknown']),
      z.enum(['ble', 'uwb', 'unknown']),
    ])
    .nullable(),
  multipleDetected: z.boolean(),
  merge: z.enum(['not-attempted', 'merged', 'no-fit', 'cancelled']),
});
const series = z.strictObject({
  id: alias,
  deviceIds: z.array(alias).min(2).max(3),
  kind: z.enum(['distance', 'multiple']),
  expectedMethod: z.enum(['ble', 'uwb']),
  distanceCm: z.union([
    z.literal(5),
    z.literal(10),
    z.literal(20),
    z.literal(30),
    z.literal(50),
    z.literal(100),
  ]),
  thirdDistanceCm: z
    .union([z.literal(30), z.literal(50), z.literal(100)])
    .nullable(),
  orientation: z.enum(['back-to-back', 'side-by-side']),
  obstruction: z.enum(['none', 'hand', 'pocket']),
  environment: z.enum(['quiet', 'crowded']),
  observationLimitMs: z.number().int().min(1000).max(60000),
  plannedTrials: z.number().int().min(20).max(1000),
  trials: z.array(trial).max(1000),
});
const report = z
  .strictObject({
    version: z.literal(1),
    evidence: z.literal('physical'),
    build: z.strictObject({
      label: alias,
      sourceSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      nativeModeConfirmed: z.boolean(),
    }),
    criteria: z.strictObject({
      status: z.enum(['proposed', 'approved']),
      reference: z.string().regex(/^[A-Z][A-Z0-9-]{0,31}$/),
    }),
    devices: z.array(device).min(2).max(16),
    series: z.array(series).min(1).max(512),
  })
  .superRefine((value, ctx) => {
    const add = (path, message) =>
      ctx.addIssue({ code: 'custom', path, message });
    const devices = new Map(value.devices.map((item) => [item.id, item]));
    if (devices.size !== value.devices.length)
      add(['devices'], 'Duplicate device alias');
    if (
      new Set(value.series.map((item) => item.id)).size !== value.series.length
    )
      add(['series'], 'Duplicate series alias');
    const measured = value.series.some((item) => item.trials.length > 0);
    if (
      measured &&
      (!value.build.sourceSha256 || !value.build.nativeModeConfirmed)
    )
      add(
        ['build'],
        'Measurements require a source fingerprint and native mode confirmation',
      );
    if (measured && value.criteria.status !== 'approved')
      add(
        ['criteria'],
        'Physical measurement requires the prior criteria decision',
      );
    value.series.forEach((item, index) => {
      const base = ['series', index];
      if (
        new Set(item.deviceIds).size !== item.deviceIds.length ||
        item.deviceIds.some((id) => !devices.has(id))
      )
        add([...base, 'deviceIds'], 'Use distinct known device aliases');
      if (
        (item.kind === 'multiple') !==
          (item.deviceIds.length === 3 && item.thirdDistanceCm !== null) ||
        (item.kind === 'distance' &&
          (item.deviceIds.length !== 2 || item.thirdDistanceCm !== null))
      )
        add(
          base,
          'Multiple-device tests require a third device and its distance',
        );
      if (item.trials.length > item.plannedTrials)
        add([...base, 'trials'], 'More trials than the predeclared plan');
      item.trials.forEach((entry, offset) => {
        const path = [...base, 'trials', offset];
        if (entry.number !== offset + 1)
          add(path, 'Trial numbers must be consecutive without duplicates');
        if (entry.outcome === 'preview' || entry.outcome === 'one-sided') {
          if (
            entry.peer === null ||
            entry.elapsedMs === null ||
            entry.elapsedMs > item.observationLimitMs ||
            entry.methods === null
          )
            add(
              path,
              'Preview requires peer, time within the observation window and method observations',
            );
          if (entry.outcome === 'one-sided' && entry.merge !== 'not-attempted')
            add(path, 'A one-sided preview cannot claim a merge result');
        } else if (
          entry.peer !== null ||
          entry.elapsedMs !== null ||
          entry.methods !== null ||
          entry.merge !== 'not-attempted'
        ) {
          add(
            path,
            'A non-preview cannot claim peer, timing, methods or merge results',
          );
        }
        if (
          entry.methods?.includes('uwb') &&
          item.deviceIds
            .slice(0, 2)
            .some((id) => devices.get(id)?.uwbCapability !== 'available')
        )
          add(
            path,
            'UWB observations require confirmed capability on both participants',
          );
      });
    });
  });

/** Reject unknown fields before outputting aggregates, including accidental private identifiers. */
export function summarizeProximity(input) {
  const value = report.parse(input);
  return {
    version: 1,
    acceptance: 'not-evaluated',
    criteriaStatus: value.criteria.status,
    series: value.series.map((item) => {
      const preview = item.trials.filter(
        (entry) => entry.outcome === 'preview',
      );
      const anyPreview = item.trials.filter(
        (entry) => entry.outcome === 'preview' || entry.outcome === 'one-sided',
      );
      const intended = preview.filter((entry) => entry.peer === 'intended');
      const aborted = item.trials.filter(
        (entry) => entry.outcome === 'aborted',
      ).length;
      const remaining = item.plannedTrials - item.trials.length;
      const complete = remaining === 0 && aborted === 0;
      const methodsConfirmed = anyPreview.every((entry) =>
        entry.methods?.every((method) => method === item.expectedMethod),
      );
      return {
        id: item.id,
        planned: item.plannedTrials,
        recorded: item.trials.length,
        remaining,
        aborted,
        complete,
        methodsConfirmed: anyPreview.length > 0 && methodsConfirmed,
        intendedPreviews: intended.length,
        oneSidedPreviews: anyPreview.length - preview.length,
        unexpectedPreviews: anyPreview.filter(
          (entry) => entry.peer === 'unexpected',
        ).length,
        timeouts: item.trials.filter((entry) => entry.outcome === 'timeout')
          .length,
        multipleDetections: item.trials.filter(
          (entry) => entry.multipleDetected,
        ).length,
        // Partial/aborted series must never look like a completed low-error measurement.
        intendedPreviewRate: complete
          ? intended.length / item.plannedTrials
          : null,
        anyPreviewRate: complete
          ? anyPreview.length / item.plannedTrials
          : null,
        maxIntendedPreviewMs: intended.length
          ? Math.max(...intended.map((entry) => entry.elapsedMs))
          : null,
        merged: preview.filter((entry) => entry.merge === 'merged').length,
        noFit: preview.filter((entry) => entry.merge === 'no-fit').length,
      };
    }),
  };
}

async function main(args) {
  if (args.length !== 1) throw new Error('usage');
  const input = JSON.parse(await readFile(args[0], 'utf8'));
  console.log(JSON.stringify(summarizeProximity(input), null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch(() => {
    // Do not print input, paths, Zod values or stack traces from potentially private records.
    console.error(
      'Invalid proximity record. Check docs/PHASE5_DEVICE_TEST_PLAN.md and the template; no input values were printed.',
    );
    process.exitCode = 1;
  });
}
