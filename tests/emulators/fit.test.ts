import {
  FitService,
  dayEndMs,
  FIT_LIMITS,
} from '../../apps/functions/src/services/fit';
import { sessionSchema } from '../../apps/functions/src/domain/models';
import { paths } from '../../apps/functions/src/repositories/paths';
import { PhotoDeletionService } from '../../apps/functions/src/services/photo-deletion';
import { backend, db, reset, safety, seedBoard, NOW, IN } from './helpers';

const images = {
  read: async (path: string) => Buffer.from(`image:${path}`),
};
const fit = new FitService(db, images, () => NOW);
beforeEach(reset);

async function pair(first: { uid: string }, second: { uid: string }) {
  const a = await fit.beginFitScan(first.uid);
  const b = await fit.beginFitScan(second.uid);
  const one = await fit.reportProximity(first.uid, a.token, b.token);
  const two = await fit.reportProximity(second.uid, b.token, a.token);
  return { a, b, one, two };
}

test('tokens require an eligible piece, are stored only as hashes, and never outlive the day', async () => {
  const a = await seedBoard('a');
  await expect(fit.beginFitScan('outsider')).rejects.toThrow(
    'failed-precondition',
  );
  const token = await fit.beginFitScan(a.uid);
  expect(token.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(token.expiresAtMs).toBe(NOW + FIT_LIMITS.tokenTtlMs);
  const stored = await db.collection('proximityTokens').get();
  expect(stored.size).toBe(1);
  expect(
    JSON.stringify(stored.docs.map((d) => [d.id, d.data()])),
  ).not.toContain(token.token);
  const late = Date.parse('2026-10-10T18:59:30Z');
  expect(dayEndMs(late)).toBe(Date.parse('2026-10-10T19:00:00Z'));
  const nearEnd = await new FitService(db, images, () => late).beginFitScan(
    a.uid,
  );
  expect(nearEnd.expiresAtMs).toBe(Date.parse('2026-10-10T19:00:00Z'));
  const full = await seedBoard('full', 20);
  await expect(fit.beginFitScan(full.uid)).rejects.toThrow(
    'failed-precondition',
  );
  await safety.setSubjectStatus(a.uid, 'suspended');
  await expect(fit.beginFitScan(a.uid)).rejects.toThrow('permission-denied');
});

test('a one-sided claim waits; mutual claims match once and converge under concurrency', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const ta = await fit.beginFitScan(a.uid);
  const tb = await fit.beginFitScan(b.uid);
  expect(await fit.reportProximity(a.uid, ta.token, tb.token)).toEqual({
    status: 'waiting',
  });
  expect((await db.collection('fitSessions').get()).empty).toBe(true);
  const [x, y] = await Promise.all([
    fit.reportProximity(b.uid, tb.token, ta.token),
    fit.reportProximity(b.uid, tb.token, ta.token),
  ]);
  expect(x).toEqual(y);
  expect(x.status).toBe('matched');
  if (x.status !== 'matched') throw new Error('Expected match');
  expect((await db.collection('fitSessions').get()).size).toBe(1);
  // The earlier reporter resends and receives the same session.
  expect(await fit.reportProximity(a.uid, ta.token, tb.token)).toEqual(x);
  const stored = sessionSchema.parse(
    (await db.doc(paths.session(x.sessionId)).get()).data(),
  );
  expect(stored.participants).toContain(a.uid);
  expect(stored.expiresAtMs).toBe(NOW + FIT_LIMITS.sessionTtlMs);
  for (const uid of [a.uid, b.uid]) {
    const view = (await db.doc(paths.fitView(uid)).get()).data();
    expect(view).toMatchObject({ sessionId: x.sessionId, stage: 'matched' });
    expect(JSON.stringify(view)).not.toContain(a.uid);
    expect(JSON.stringify(view)).not.toContain(b.uid);
  }
  await backend.confirmFit(a.uid, x.sessionId);
  const outcome = await backend.confirmFit(b.uid, x.sessionId);
  expect(outcome.status).toBe('merged');
  expect((await db.doc(paths.fitView(a.uid)).get()).data()).toMatchObject({
    stage: 'merged',
    boardChanged: false,
  });
});

test('foreign, unknown, expired and previous-day tokens never match', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const ta = await fit.beginFitScan(a.uid);
  const tb = await fit.beginFitScan(b.uid);
  await expect(fit.reportProximity(b.uid, ta.token, tb.token)).rejects.toThrow(
    'permission-denied',
  );
  await expect(fit.reportProximity(a.uid, ta.token, ta.token)).rejects.toThrow(
    'invalid-argument',
  );
  expect(await fit.reportProximity(a.uid, ta.token, 'A'.repeat(22))).toEqual({
    status: 'expired',
  });
  await expect(
    fit.reportProximity(a.uid, 'B'.repeat(22), tb.token),
  ).rejects.toThrow('failed-precondition');
  const later = new FitService(db, images, () => ta.expiresAtMs + 1);
  expect(await later.reportProximity(a.uid, ta.token, tb.token)).toEqual({
    status: 'expired',
  });
  const tomorrow = new FitService(db, images, () => dayEndMs(NOW) + 1);
  expect(await tomorrow.reportProximity(a.uid, ta.token, tb.token)).toEqual({
    status: 'expired',
  });
  expect((await db.collection('fitSessions').get()).empty).toBe(true);
});

test('a third device cannot join a matched pair, and one token cannot claim two peers', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const c = await seedBoard('c', 1, IN);
  const { a: ta, b: tb, two } = await pair(a, b);
  expect(two.status).toBe('matched');
  const tc = await fit.beginFitScan(c.uid);
  expect(await fit.reportProximity(c.uid, tc.token, ta.token)).toEqual({
    status: 'conflict',
  });
  expect(await fit.reportProximity(a.uid, ta.token, tc.token)).toEqual({
    status: 'conflict',
  });
  expect(await fit.reportProximity(a.uid, ta.token, tb.token)).toEqual(two);
  // A device that claims two different peers with one token is ambiguous.
  const d = await seedBoard('d', 1, IN);
  const e = await seedBoard('e', 1, IN);
  const td = await fit.beginFitScan(d.uid);
  const te = await fit.beginFitScan(e.uid);
  const tf = await fit.beginFitScan(c.uid);
  await fit.reportProximity(d.uid, td.token, te.token);
  expect(await fit.reportProximity(d.uid, td.token, tf.token)).toEqual({
    status: 'conflict',
  });
  expect((await fit.reportProximity(e.uid, te.token, td.token)).status).toBe(
    'matched',
  );
  // One-sided claims by an outsider about a live token create no session and block nobody.
  expect((await db.collection('fitSessions').get()).size).toBe(2);
});

test('people already on one board end without a session; ineligible peers look like waiting', async () => {
  const both = await seedBoard('both', 2);
  const [a, b] = both.members;
  if (!a || !b) throw new Error('Missing members');
  const { two } = await pair(a, b);
  expect(two).toEqual({ status: 'already-connected' });
  expect((await db.collection('fitSessions').get()).empty).toBe(true);
  const c = await seedBoard('c');
  const d = await seedBoard('d', 1, IN);
  const tc = await fit.beginFitScan(c.uid);
  const td = await fit.beginFitScan(d.uid);
  await safety.setSubjectStatus(d.uid, 'suspended');
  await fit.reportProximity(c.uid, tc.token, td.token);
  expect(await fit.reportProximity(d.uid, td.token, tc.token)).toEqual({
    status: 'waiting',
  });
  expect(await fit.reportProximity(c.uid, tc.token, td.token)).toEqual({
    status: 'waiting',
  });
});

test('preview shows only the counterpart piece and is re-checked for safety on every read', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const { two } = await pair(a, b);
  if (two.status !== 'matched') throw new Error('Expected match');
  const preview = await fit.getFitPreview(a.uid, two.sessionId);
  expect(preview).toMatchObject({
    visibility: 'visible',
    username: 'Synthetic name',
    caption: 'Synthetic caption',
    edges: IN,
  });
  expect(Buffer.from(preview.imageBase64 ?? '', 'base64').toString()).toBe(
    `image:normalized/${b.pieceId}/image`,
  );
  expect(JSON.stringify(preview)).not.toContain(a.uid);
  expect(JSON.stringify(preview)).not.toContain(b.uid);
  await expect(fit.getFitPreview('outsider', two.sessionId)).rejects.toThrow(
    'permission-denied',
  );
  await db.doc(paths.block(a.uid, b.uid)).set({ blocked: true });
  const blank = await fit.getFitPreview(a.uid, two.sessionId);
  expect(blank).toMatchObject({
    visibility: 'blank',
    username: null,
    caption: null,
    imageBase64: null,
    edges: IN,
  });
  expect((await fit.getFitPreview(b.uid, two.sessionId)).visibility).toBe(
    'blank',
  );
  await db.doc(paths.block(a.uid, b.uid)).delete();
  await new PhotoDeletionService(db, {
    remove: async () => undefined,
  }).removeOwn(b.uid, b.pieceId);
  expect((await fit.getFitPreview(a.uid, two.sessionId)).visibility).toBe(
    'blank',
  );
});

test('leaving cancels the session before confirmation; a consumed session is unchanged', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b', 1, IN);
  const { two } = await pair(a, b);
  if (two.status !== 'matched') throw new Error('Expected match');
  await expect(fit.leaveFit('outsider', two.sessionId)).rejects.toThrow(
    'permission-denied',
  );
  expect(await fit.leaveFit(b.uid, two.sessionId)).toEqual({ cancelled: true });
  expect((await db.doc(paths.fitView(a.uid)).get()).data()).toMatchObject({
    stage: 'cancelled',
  });
  await expect(backend.confirmFit(a.uid, two.sessionId)).rejects.toThrow(
    'failed-precondition',
  );
  await expect(fit.getFitPreview(a.uid, two.sessionId)).rejects.toThrow(
    'failed-precondition',
  );
  const c = await seedBoard('c');
  const d = await seedBoard('d', 1, IN);
  const next = await pair(c, d);
  if (next.two.status !== 'matched') throw new Error('Expected match');
  await backend.confirmFit(c.uid, next.two.sessionId);
  await backend.confirmFit(d.uid, next.two.sessionId);
  expect(await fit.leaveFit(c.uid, next.two.sessionId)).toEqual({
    cancelled: false,
  });
  expect((await db.doc(paths.fitView(c.uid)).get()).data()).toMatchObject({
    stage: 'merged',
  });
});

test('a failed retry on a changed board is reported separately from a plain no-placement', async () => {
  const a = await seedBoard('a');
  const b = await seedBoard('b');
  const { two } = await pair(a, b);
  if (two.status !== 'matched') throw new Error('Expected match');
  await backend.confirmFit(a.uid, two.sessionId);
  expect(await backend.confirmFit(b.uid, two.sessionId)).toEqual({
    status: 'not-merged',
    reason: 'no-placement',
  });
  expect((await db.doc(paths.fitView(a.uid)).get()).data()).toMatchObject({
    stage: 'not-merged',
    reason: 'no-placement',
    boardChanged: false,
  });
  const c = await seedBoard('c');
  const d = await seedBoard('d');
  const next = await pair(c, d);
  if (next.two.status !== 'matched') throw new Error('Expected match');
  // Simulate a board advancing after matching by recording an older version.
  await db.doc(paths.session(next.two.sessionId)).update({
    boards: { [c.boardId]: 7, [d.boardId]: 1 },
  });
  await backend.confirmFit(c.uid, next.two.sessionId);
  await backend.confirmFit(d.uid, next.two.sessionId);
  expect((await db.doc(paths.fitView(d.uid)).get()).data()).toMatchObject({
    stage: 'not-merged',
    boardChanged: true,
  });
});

test('request rates are limited per user and recover after the window', async () => {
  const a = await seedBoard('a');
  for (let i = 0; i < FIT_LIMITS.begin.limit; i += 1)
    await fit.beginFitScan(a.uid);
  await expect(fit.beginFitScan(a.uid)).rejects.toThrow('resource-exhausted');
  const later = new FitService(
    db,
    images,
    () => NOW + FIT_LIMITS.begin.windowMs,
  );
  await expect(later.beginFitScan(a.uid)).resolves.toBeDefined();
  const b = await seedBoard('b', 1, IN);
  const tb = await fit.beginFitScan(b.uid);
  for (let i = 0; i < FIT_LIMITS.report.limit; i += 1)
    await fit.reportProximity(b.uid, tb.token, 'A'.repeat(22));
  await expect(
    fit.reportProximity(b.uid, tb.token, 'A'.repeat(22)),
  ).rejects.toThrow('resource-exhausted');
});
