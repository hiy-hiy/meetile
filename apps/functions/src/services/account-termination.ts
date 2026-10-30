import { randomUUID } from 'node:crypto';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import type { Auth } from 'firebase-admin/auth';
import { z } from 'zod';
import { endUseSchema } from '@puzzle-sns/contracts';
import { privateCaptureSchema } from '../domain/capture';
import { requireCondition } from '../domain/errors';
import { pieceSchema, subjectSchema } from '../domain/models';
import { readModel } from '../repositories/documents';
import { paths } from '../repositories/paths';
import { PhotoDeletionService } from './photo-deletion';
import { SafetyFoundation } from './safety';

const PAGE = 20;
// Longer than one callable/scheduler invocation, so a live worker keeps its claim.
const LEASE_MS = 240_000;
const jobSchema = z.strictObject({
  status: z.literal('pending'),
  requestedAtMs: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  leaseToken: z.string().nullable(),
  leaseUntilMs: z.number().int().nonnegative(),
});
// Per-subject client data with no safety-retention purpose (spec §18.2).
const CLIENT_ROOTS = ['views', 'viewGrants', 'hidden', 'captureOwners'];

export interface Principals {
  delete(uid: string): Promise<void>;
}
export class FirebasePrincipals implements Principals {
  constructor(private readonly auth: Auth) {}
  async delete(uid: string): Promise<void> {
    try {
      await this.auth.deleteUser(uid);
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'auth/user-not-found'
      )
        throw error;
    }
  }
}

/**
 * D-06 end of use. The subject is closed atomically; the resumable private job
 * then blanks every own photo across days, removes client data and finally the
 * anonymous Auth principal. Geometry, daily membership, reports, blocks,
 * suspension records and held review items are retained (retention: G-SAFETY).
 */
export class AccountTerminationService {
  private readonly safety: SafetyFoundation;
  private readonly deletions: PhotoDeletionService;
  constructor(
    private readonly db: Firestore,
    private readonly photos: { remove(path: string): Promise<void> },
    private readonly principals: Principals,
    private readonly clock: () => number = Date.now,
  ) {
    this.safety = new SafetyFoundation(db);
    this.deletions = new PhotoDeletionService(db, photos);
  }
  async end(uid: string, input: unknown): Promise<{ status: 'ended' }> {
    endUseSchema.parse(input);
    await this.db.runTransaction(async (tx) => {
      const subjectRef = this.db.doc(paths.subject(uid));
      const jobRef = this.db.doc(paths.termination(uid));
      const snapshot = await tx.get(subjectRef);
      const job = await tx.get(jobRef);
      const subject = snapshot.exists
        ? subjectSchema.parse(snapshot.data())
        : null;
      // Pending legal review (PHASE4.md): suspended subjects are refused for now.
      requireCondition(subject?.status !== 'suspended', 'permission-denied');
      if (!subject) tx.create(subjectRef, { status: 'ended', accessEpoch: 0 });
      else if (subject.status === 'active') {
        requireCondition(Number.isSafeInteger(subject.accessEpoch + 1));
        // Rules and every service require an active subject, so old tokens,
        // grants and image paths stop working with this single commit.
        tx.update(subjectRef, {
          status: 'ended',
          accessEpoch: subject.accessEpoch + 1,
        });
      }
      tx.delete(this.db.doc(paths.clientState(uid)));
      if (!job.exists)
        tx.create(jobRef, {
          status: 'pending',
          requestedAtMs: this.clock(),
          attemptCount: 0,
          leaseToken: null,
          leaseUntilMs: 0,
        });
    });
    await this.process(uid);
    return { status: 'ended' };
  }
  async resume(): Promise<void> {
    const jobs = await this.db
      .collection('accountTerminations')
      .where('status', '==', 'pending')
      .limit(10)
      .get();
    for (const job of jobs.docs) await this.process(job.id);
  }
  private async process(uid: string): Promise<void> {
    const ref = this.db.doc(paths.termination(uid));
    const token = randomUUID();
    const claimed = await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const job = jobSchema.parse(snapshot.data());
      if (job.leaseUntilMs > this.clock()) return false;
      tx.update(ref, {
        leaseToken: token,
        leaseUntilMs: this.clock() + LEASE_MS,
      });
      return true;
    });
    if (!claimed) return;
    try {
      const subject = await this.db.doc(paths.subject(uid)).get();
      requireCondition(subjectSchema.parse(subject.data()).status === 'ended');
      await this.blankPieces(uid);
      await this.scrubCaptures(uid);
      await this.deleteClientData(uid);
      // Last, so a failed step can still be retried by the scheduler.
      await this.principals.delete(uid);
      await this.db.runTransaction(async (tx) => {
        const latest = await tx.get(ref);
        if (latest.exists && latest.get('leaseToken') === token) tx.delete(ref);
      });
    } catch {
      // No UID, path or photo content is logged; the private job is the record.
      await this.db.runTransaction(async (tx) => {
        const latest = await tx.get(ref);
        if (!latest.exists || latest.get('leaseToken') !== token) return;
        const job = jobSchema.parse(latest.data());
        if (Number.isSafeInteger(job.attemptCount + 1))
          tx.update(ref, {
            attemptCount: job.attemptCount + 1,
            leaseToken: null,
            leaseUntilMs: 0,
          });
      });
    }
  }
  /** Every day's published photo, through the same scrub as an operator removal. */
  private async blankPieces(uid: string): Promise<void> {
    for (;;) {
      const page = await this.db
        .collection('pieces')
        .where('ownerUid', '==', uid)
        .where('status', '==', 'approved')
        .limit(PAGE)
        .get();
      if (page.empty) return;
      for (const doc of page.docs) {
        await this.db.runTransaction(async (tx) => {
          const subject = await readModel(
            this.db,
            tx,
            paths.subject(uid),
            subjectSchema,
          );
          requireCondition(subject.status === 'ended');
          const piece = await readModel(
            this.db,
            tx,
            paths.piece(doc.id),
            pieceSchema,
          );
          requireCondition(piece.ownerUid === uid);
          await this.safety.removePieceInTransaction(
            tx,
            doc.id,
            'deleted',
            undefined,
            true,
          );
        });
        await this.deletions.cleanOne(doc.id);
      }
    }
  }
  /** Unpublished captures and approvals; held review items stay for G-SAFETY. */
  private async scrubCaptures(uid: string): Promise<void> {
    for (let cursor: string | null = null; ;) {
      const page = await this.ownedPage('captures', uid, cursor);
      for (const doc of page.docs) {
        const capture = privateCaptureSchema.parse(doc.data());
        if (capture.username !== null || capture.caption !== null)
          await doc.ref.update({ username: null, caption: null });
        await this.photos.remove(capture.uploadPath);
        // Publication requires an active subject, so a missing piece stays unpublished.
        const piece = await this.db.doc(paths.piece(capture.pieceId)).get();
        if (!piece.exists)
          await this.photos.remove(`normalized/${capture.pieceId}/image`);
      }
      cursor = page.size < PAGE ? null : (page.docs.at(-1)?.id ?? null);
      if (!cursor) break;
    }
    for (let cursor: string | null = null; ;) {
      const page = await this.ownedPage('approvals', uid, cursor);
      for (const doc of page.docs)
        if (doc.get('username') !== '' || doc.get('caption') !== '')
          await doc.ref.update({ username: '', caption: '' });
      cursor = page.size < PAGE ? null : (page.docs.at(-1)?.id ?? null);
      if (!cursor) break;
    }
  }
  private ownedPage(collection: string, uid: string, cursor: string | null) {
    const query = this.db
      .collection(collection)
      .where('ownerUid', '==', uid)
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    return (cursor ? query.startAfter(cursor) : query).get();
  }
  private async deleteClientData(uid: string): Promise<void> {
    for (const root of CLIENT_ROOTS)
      await this.db.recursiveDelete(this.db.collection(root).doc(uid));
    await Promise.all([
      this.db.doc(paths.clientState(uid)).delete(),
      this.db.doc(`consents/${uid}`).delete(),
    ]);
  }
}
