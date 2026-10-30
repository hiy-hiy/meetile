import { randomUUID } from 'node:crypto';
import {
  CaptureService,
  type PhotoProcessor,
} from '../../apps/functions/src/services/capture';
import { HeldReviewService } from '../../apps/functions/src/services/held-review';
import { Backend } from '../../apps/functions/src/services/backend';
import { PhotoDeletionService } from '../../apps/functions/src/services/photo-deletion';
import { AccountTerminationService } from '../../apps/functions/src/services/account-termination';
import { paths } from '../../apps/functions/src/repositories/paths';
import type { Decision } from '../../apps/functions/src/domain/moderation';
import { db, reset, safety, NOW, DAY } from './helpers';

class ArtificialPhotos implements PhotoProcessor {
  objects = new Map<string, Buffer>();
  decision: Decision = 'held';
  failRead = false;
  failRemoval = false;
  async has(path: string) {
    return this.objects.has(path);
  }
  async read(path: string) {
    const image = this.objects.get(path);
    if (this.failRead || !image) throw new Error('Synthetic read failure');
    return image;
  }
  async save(path: string, image: Buffer) {
    const old = this.objects.get(path);
    if (old && !old.equals(image)) throw new Error('Immutable object');
    this.objects.set(path, image);
  }
  async remove(path: string) {
    if (this.failRemoval) throw new Error('Synthetic removal outage');
    this.objects.delete(path);
  }
  async process() {
    return {
      decision: this.decision,
      image: Buffer.from('synthetic re-encoded image'),
    };
  }
}
let photos: ArtificialPhotos;
let now: number;
let capture: CaptureService;
let held: HeldReviewService;
const clock = () => now;
beforeEach(async () => {
  await reset();
  photos = new ArtificialPhotos();
  now = NOW;
  capture = new CaptureService(db, photos, 'v1', clock);
  held = new HeldReviewService(db, photos, clock);
  await db.doc('adminOperators/operator').set({ enabled: true });
  await db.doc('adminOperators/second').set({ enabled: true });
});
async function heldCapture(uid = 'owner') {
  await new Backend(db, clock).getDayState(uid);
  await capture.acceptOnboarding(uid, {
    age16OrOlder: true,
    accepted: true,
    legalVersion: 'v1',
  });
  const begun = await capture.begin(uid);
  await capture.upload(uid, {
    captureId: begun.captureId,
    base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  });
  const result = await capture.submit(uid, {
    captureId: begun.captureId,
    username: '人工署名',
    caption: '人工キャプション',
  });
  expect(result.status).toBe('held');
  return begun.captureId;
}
const decision = (
  caseId: string,
  value: 'approve' | 'reject',
  requestId: string = randomUUID(),
) => ({ caseId, requestId, decision: value, note: '人工検証の判断' });
const pieceIdOf = async (caseId: string) =>
  String((await db.doc(`captures/${caseId}`).get()).get('pieceId'));

test('every held-review operation denies unlisted or disabled operators without audit or decisions', async () => {
  const caseId = await heldCapture();
  await db.doc('adminOperators/operator').set({ enabled: false });
  for (const uid of ['stranger', 'operator']) {
    await expect(held.list(uid, {})).rejects.toThrow('permission-denied');
    await expect(held.detail(uid, caseId)).rejects.toThrow('permission-denied');
    await expect(held.imageTarget(uid, caseId)).rejects.toThrow(
      'permission-denied',
    );
    await expect(held.decide(uid, decision(caseId, 'approve'))).rejects.toThrow(
      'permission-denied',
    );
  }
  expect((await db.collection('adminAudit').get()).empty).toBe(true);
  expect((await db.collection('adminHeldDecisions').get()).empty).toBe(true);
  expect((await db.collection('pieces').get()).empty).toBe(true);
});
test('operator DTOs omit the owner identity; list, detail and image access are audited', async () => {
  const caseId = await heldCapture();
  const list = await held.list('operator', {});
  const detail = await held.detail('operator', caseId);
  expect(list.items).toEqual([
    expect.objectContaining({ caseId, dayKey: DAY, status: 'pending' }),
  ]);
  expect(detail).toMatchObject({
    username: '人工署名',
    caption: '人工キャプション',
    blocked: null,
    subjectState: 'active',
    imageAvailable: true,
  });
  expect(JSON.stringify({ list, detail })).not.toMatch(
    /owner|ownerUid|pieceId|imagePath|reviewerUid/,
  );
  expect(await held.imageTarget('operator', caseId)).toBe(
    `review/${caseId}/image`,
  );
  const actions = (await db.collection('adminAudit').get()).docs.map((doc) =>
    String(doc.get('action')),
  );
  expect(actions.sort()).toEqual(['list-held', 'view-held', 'view-held-image']);
  await expect(held.detail('operator', randomUUID())).rejects.toThrow(
    'not-found',
  );
});
test('approval publishes one piece the same day and commits decision, receipt and audit with it', async () => {
  const caseId = await heldCapture();
  const pieceId = await pieceIdOf(caseId);
  await held.decide('operator', decision(caseId, 'approve'));
  const day = await new Backend(db, clock).getDayState('owner');
  expect(day).toMatchObject({ photoState: 'ready', ownPieceId: pieceId });
  expect(
    await db
      .doc(paths.piece(pieceId))
      .get()
      .then((d) => d.data()),
  ).toMatchObject({ status: 'approved', username: '人工署名' });
  expect((await db.doc(paths.media(pieceId)).get()).get('visible')).toBe(true);
  expect((await capture.get('owner', caseId)).status).toBe('approved');
  expect((await db.doc(`reviewQueue/${caseId}`).get()).data()).toMatchObject({
    status: 'reviewed',
    decision: 'approve',
    note: '人工検証の判断',
  });
  expect((await db.collection('adminHeldDecisions').get()).size).toBe(1);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'approve-held')
        .get()
    ).size,
  ).toBe(1);
  // Only the normalized piece remains, so the owner's deletion removes every copy (§14).
  expect(photos.objects.has(`normalized/${pieceId}/image`)).toBe(true);
  expect(photos.objects.has(`review/${caseId}/image`)).toBe(false);
  await expect(held.imageTarget('operator', caseId)).rejects.toThrow(
    'not-found',
  );
  await new PhotoDeletionService(db, photos).removeOwn('owner', pieceId);
  expect(
    [...photos.objects.keys()].filter((key) => key.includes(pieceId)),
  ).toEqual([]);
});
test('rejection keeps the photo unpublished and lets the owner photograph again today', async () => {
  const caseId = await heldCapture();
  await held.decide('operator', decision(caseId, 'reject'));
  expect((await capture.get('owner', caseId)).status).toBe('rejected');
  expect((await capture.begin('owner')).captureId).not.toBe(caseId);
  expect((await db.collection('pieces').get()).empty).toBe(true);
  expect((await db.doc(paths.approval(caseId)).get()).exists).toBe(false);
  // Evidence retention is undecided (G-SAFETY); nothing is deleted yet.
  expect(photos.objects.has(`review/${caseId}/image`)).toBe(true);
  expect((await held.detail('operator', caseId)).blocked).toBe('decided');
});
test('retries are idempotent; changed retries, a second operator and opposite decisions cannot overwrite', async () => {
  const caseId = await heldCapture();
  const requestId = randomUUID();
  await held.decide('operator', decision(caseId, 'approve', requestId));
  await held.decide('operator', decision(caseId, 'approve', requestId));
  await expect(
    held.decide('operator', {
      ...decision(caseId, 'approve', requestId),
      note: '変更した理由',
    }),
  ).rejects.toThrow();
  await expect(
    held.decide('operator', decision(caseId, 'reject', requestId)),
  ).rejects.toThrow();
  await expect(
    held.decide('second', decision(caseId, 'reject')),
  ).rejects.toThrow();
  expect((await db.collection('pieces').get()).size).toBe(1);
  expect((await db.doc(`reviewQueue/${caseId}`).get()).get('decision')).toBe(
    'approve',
  );
});
test('concurrent approval and rejection settle on exactly one consistent outcome', async () => {
  const caseId = await heldCapture();
  const results = await Promise.allSettled([
    held.decide('operator', decision(caseId, 'approve')),
    held.decide('second', decision(caseId, 'reject')),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const review = (await db.doc(`reviewQueue/${caseId}`).get()).data();
  const pieces = (await db.collection('pieces').get()).size;
  expect((await db.collection('adminHeldDecisions').get()).size).toBe(1);
  if (review?.decision === 'approve') expect(pieces).toBe(1);
  else {
    expect(review?.decision).toBe('reject');
    expect(pieces).toBe(0);
    expect((await capture.get('owner', caseId)).status).toBe('rejected');
  }
});
test('after the 4 a.m. boundary a held photo can no longer be published, only withheld', async () => {
  const caseId = await heldCapture();
  now = Date.parse(`${DAY}T19:00:00Z`);
  expect((await held.detail('operator', caseId)).blocked).toBe('day-ended');
  await expect(
    held.decide('operator', decision(caseId, 'approve')),
  ).rejects.toThrow();
  expect((await db.collection('pieces').get()).empty).toBe(true);
  await held.decide('operator', decision(caseId, 'reject'));
  expect((await db.doc(`captures/${caseId}`).get()).get('status')).toBe(
    'expired',
  );
});
test('suspended or ended owners are never published by an approval', async () => {
  const suspended = await heldCapture('suspended-owner');
  await safety.setSubjectStatus('suspended-owner', 'suspended');
  expect(await held.detail('operator', suspended)).toMatchObject({
    blocked: 'subject',
    subjectState: 'suspended',
  });
  await expect(
    held.decide('operator', decision(suspended, 'approve')),
  ).rejects.toThrow();
  const ended = await heldCapture('ended-owner');
  await new AccountTerminationService(
    db,
    photos,
    { delete: async () => {} },
    clock,
  ).end('ended-owner', {
    confirm: true,
  });
  await expect(
    held.decide('operator', decision(ended, 'approve')),
  ).rejects.toThrow();
  // Held evidence is retained across termination (G-SAFETY) and can still be withheld.
  await held.decide('operator', decision(ended, 'reject'));
  expect((await db.collection('pieces').get()).empty).toBe(true);
});
test('an interrupted approval publishes nothing and recovers by retry or rejection', async () => {
  const caseId = await heldCapture();
  const pieceId = await pieceIdOf(caseId);
  const requestId = randomUUID();
  photos.failRead = true;
  await expect(
    held.decide('operator', decision(caseId, 'approve', requestId)),
  ).rejects.toThrow();
  expect((await db.collection('pieces').get()).empty).toBe(true);
  expect((await db.doc(`reviewQueue/${caseId}`).get()).get('status')).toBe(
    'pending',
  );
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'approve-held')
        .get()
    ).empty,
  ).toBe(true);
  photos.failRead = false;
  await held.decide('operator', decision(caseId, 'approve', requestId));
  expect((await new Backend(db, clock).getDayState('owner')).ownPieceId).toBe(
    pieceId,
  );
  const other = await heldCapture('other-owner');
  photos.failRead = true;
  await expect(
    held.decide('operator', decision(other, 'approve')),
  ).rejects.toThrow();
  photos.failRead = false;
  await held.decide('operator', decision(other, 'reject'));
  expect((await db.doc(paths.approval(other)).get()).exists).toBe(false);
});
test('a review copy left by a failed removal after approval is reclaimed by expiry cleanup', async () => {
  const caseId = await heldCapture();
  const pieceId = await pieceIdOf(caseId);
  photos.failRemoval = true;
  await held.decide('operator', decision(caseId, 'approve'));
  expect(photos.objects.has(`review/${caseId}/image`)).toBe(true);
  photos.failRemoval = false;
  now = Date.parse(`${DAY}T19:00:00Z`);
  await capture.cleanupExpired();
  expect(photos.objects.has(`review/${caseId}/image`)).toBe(false);
  expect(photos.objects.has(`normalized/${pieceId}/image`)).toBe(true);
});
test('expiry cleanup keeps evidence of rejected and still-pending held photos', async () => {
  const rejected = await heldCapture();
  await held.decide('operator', decision(rejected, 'reject'));
  const pending = await heldCapture('pending-owner');
  now = Date.parse(`${DAY}T19:00:00Z`);
  await capture.cleanupExpired();
  expect(photos.objects.has(`review/${rejected}/image`)).toBe(true);
  expect(photos.objects.has(`review/${pending}/image`)).toBe(true);
});
