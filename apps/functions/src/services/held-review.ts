import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { dayKeySchema } from '@puzzle-sns/contracts';
import { requireCondition } from '../domain/errors';
import { privateCaptureSchema } from '../domain/capture';
import { subjectSchema } from '../domain/models';
import { dayKeyAt } from '../domain/time';
import { paths } from '../repositories/paths';
import { readModel } from '../repositories/documents';
import { Backend } from './backend';
import { authorizeOperator, recordAudit } from './admin-moderation';

export const heldCaseIdSchema = z.uuid();
export const heldListSchema = z.strictObject({
  status: z.enum(['pending', 'reviewed']).default('pending'),
  cursor: heldCaseIdSchema.optional(),
});
export const heldDecisionSchema = z.strictObject({
  caseId: heldCaseIdSchema,
  requestId: z.uuid(),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(1).max(500),
});
const reviewSchema = z.object({
  captureId: heldCaseIdSchema,
  ownerUid: z.string().min(1).max(128),
  dayKey: dayKeySchema,
  status: z.enum(['pending', 'reviewed']),
  imagePath: z.string(),
  username: z.string().nullable(),
  caption: z.string().nullable(),
  heldAtMs: z.number().int().nonnegative().optional(),
  decision: z.enum(['approve', 'reject']).optional(),
  note: z.string().optional(),
  reviewedAtMs: z.number().int().nonnegative().optional(),
});
type Review = z.infer<typeof reviewSchema>;
export interface AdminHeldItem {
  caseId: string;
  dayKey: string;
  status: 'pending' | 'reviewed';
  heldAtMs: number | null;
  decision: 'approve' | 'reject' | null;
  note: string | null;
  reviewedAtMs: number | null;
}
export interface AdminHeldDetail {
  item: AdminHeldItem;
  username: string | null;
  caption: string | null;
  subjectState: 'active' | 'suspended' | 'ended' | 'missing';
  /** Why publication is impossible now; null when an approval can publish today. */
  blocked: 'decided' | 'day-ended' | 'subject' | 'state' | null;
  imageAvailable: boolean;
}
/** Storage access for review evidence and the normalized published copy. */
export interface HeldPhotos {
  read(path: string): Promise<Buffer>;
  save(path: string, image: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
}
const reviewPath = (id: string) => `reviewQueue/${heldCaseIdSchema.parse(id)}`;
const imagePath = (id: string) => `review/${heldCaseIdSchema.parse(id)}/image`;
function item(id: string, review: Review): AdminHeldItem {
  return {
    caseId: id,
    dayKey: review.dayKey,
    status: review.status,
    heldAtMs: review.heldAtMs ?? null,
    decision: review.decision ?? null,
    note: review.note ?? null,
    reviewedAtMs: review.reviewedAtMs ?? null,
  };
}

/**
 * Human review of captures the automatic moderation held back. Admin server
 * only; never exposed as a mobile Callable. Owner identities stay server-side.
 */
export class HeldReviewService {
  constructor(
    private readonly db: Firestore,
    private readonly photos: HeldPhotos,
    private readonly clock: () => number = Date.now,
  ) {}
  private audit(
    tx: Transaction,
    uid: string,
    action: string,
    caseId: string | null,
    id?: string,
  ) {
    recordAudit(this.db, tx, { uid, action, caseId, atMs: this.clock() }, id);
  }
  private async read(tx: Transaction, id: string): Promise<Review> {
    const doc = await tx.get(this.db.doc(reviewPath(id)));
    requireCondition(doc.exists, 'not-found');
    const review = reviewSchema.parse(doc.data());
    requireCondition(
      review.captureId === id && review.imagePath === imagePath(id),
    );
    return review;
  }
  /** Same-day publication only (§3.1, §10): later decisions can only withhold. */
  private async blocked(
    tx: Transaction,
    id: string,
    review: Review,
  ): Promise<{
    blocked: AdminHeldDetail['blocked'];
    subjectState: AdminHeldDetail['subjectState'];
  }> {
    const [captureDoc, subjectDoc] = await Promise.all([
      tx.get(this.db.doc(`captures/${id}`)),
      tx.get(this.db.doc(paths.subject(review.ownerUid))),
    ]);
    const subjectState = subjectDoc.exists
      ? subjectSchema.parse(subjectDoc.data()).status
      : 'missing';
    if (review.status !== 'pending')
      return { blocked: 'decided', subjectState };
    const capture = captureDoc.exists
      ? privateCaptureSchema.parse(captureDoc.data())
      : null;
    const now = this.clock();
    if (
      !capture ||
      capture.ownerUid !== review.ownerUid ||
      capture.status !== 'held'
    )
      return { blocked: 'state', subjectState };
    if (dayKeyAt(now) !== capture.dayKey || now >= capture.expiresAtMs)
      return { blocked: 'day-ended', subjectState };
    if (subjectState !== 'active') return { blocked: 'subject', subjectState };
    return { blocked: null, subjectState };
  }
  async list(
    uid: string,
    input: unknown,
  ): Promise<{ items: AdminHeldItem[]; nextCursor: string | null }> {
    const data = heldListSchema.parse(input);
    return this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      let query = this.db
        .collection('reviewQueue')
        .where('status', '==', data.status)
        .orderBy('__name__')
        .limit(26);
      if (data.cursor) query = query.startAfter(data.cursor);
      const docs = await tx.get(query);
      const items = docs.docs
        .slice(0, 25)
        .map((doc) => item(doc.id, reviewSchema.parse(doc.data())));
      this.audit(tx, uid, 'list-held', null);
      return {
        items,
        nextCursor: docs.size > 25 ? (items.at(-1)?.caseId ?? null) : null,
      };
    });
  }
  async detail(uid: string, caseId: string): Promise<AdminHeldDetail> {
    const id = heldCaseIdSchema.parse(caseId);
    return this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      const review = await this.read(tx, id);
      const state = await this.blocked(tx, id, review);
      this.audit(tx, uid, 'view-held', id);
      return {
        item: item(id, review),
        username: review.username,
        caption: review.caption,
        ...state,
        imageAvailable: review.decision !== 'approve',
      };
    });
  }
  /** The review copy only; after an approval the photo follows normal piece access. */
  async imageTarget(uid: string, caseId: string): Promise<string> {
    const id = heldCaseIdSchema.parse(caseId);
    return this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      const review = await this.read(tx, id);
      requireCondition(review.decision !== 'approve', 'not-found');
      this.audit(tx, uid, 'view-held-image', id);
      return imagePath(id);
    });
  }
  async decide(
    uid: string,
    input: unknown,
  ): Promise<{ status: 'reviewed'; decision: 'approve' | 'reject' }> {
    const data = heldDecisionSchema.parse(input);
    const receiptId = createHash('sha256')
      .update(JSON.stringify(['held', uid, data.requestId]))
      .digest('hex');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
    const receiptRef = this.db.doc(`adminHeldDecisions/${receiptId}`);
    const record = (tx: Transaction) => {
      const atMs = this.clock();
      tx.update(this.db.doc(reviewPath(data.caseId)), {
        status: 'reviewed',
        decision: data.decision,
        note: data.note,
        reviewedAtMs: atMs,
        reviewerUid: uid,
      });
      tx.create(receiptRef, {
        fingerprint,
        caseId: data.caseId,
        decision: data.decision,
        atMs,
      });
      this.audit(
        tx,
        uid,
        data.decision === 'approve' ? 'approve-held' : 'reject-held',
        data.caseId,
        receiptId,
      );
    };
    // Returns the capture to publish, or null when already decided/recorded.
    const prepared = await this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      const receipt = await tx.get(receiptRef);
      if (receipt.exists) {
        requireCondition(receipt.get('fingerprint') === fingerprint);
        return null;
      }
      const review = await this.read(tx, data.caseId);
      requireCondition(review.status === 'pending');
      const { blocked } = await this.blocked(tx, data.caseId, review);
      const capture = await readModel(
        this.db,
        tx,
        `captures/${data.caseId}`,
        privateCaptureSchema,
      );
      if (data.decision === 'reject') {
        // Not a piece yet, so the owner may photograph again today (§3.2).
        if (blocked !== 'state' && capture.status === 'held')
          tx.update(this.db.doc(`captures/${data.caseId}`), {
            status: blocked === 'day-ended' ? 'expired' : 'rejected',
            leaseUntilMs: 0,
          });
        // Drop an approval left by an interrupted earlier approval attempt.
        tx.delete(this.db.doc(paths.approval(data.caseId)));
        record(tx);
        return null;
      }
      requireCondition(blocked === null);
      // The approval document grants nothing alone; publication rechecks everything.
      tx.set(this.db.doc(paths.approval(data.caseId)), {
        ownerUid: review.ownerUid,
        dayKey: capture.dayKey,
        status: 'approved',
        normalizedPieceId: capture.pieceId,
        username: review.username ?? '',
        caption: review.caption ?? '',
      });
      return capture;
    });
    if (!prepared) return { status: 'reviewed', decision: data.decision };
    const normalized = `normalized/${prepared.pieceId}/image`;
    // Unreadable until the piece and its media grant exist; an unpublished copy
    // is reclaimed by the capture's expiry cleanup.
    await this.photos.save(
      normalized,
      await this.photos.read(imagePath(data.caseId)),
    );
    await new Backend(this.db, this.clock).publishApprovedPiece(
      data.caseId,
      undefined,
      {
        captureId: data.caseId,
        verify: async (tx) => {
          await authorizeOperator(this.db, tx, uid);
          requireCondition(!(await tx.get(receiptRef)).exists);
          requireCondition(
            (await this.read(tx, data.caseId)).status === 'pending',
          );
        },
        record,
      },
    );
    try {
      await this.photos.remove(imagePath(data.caseId));
    } catch {
      /* The capture's expiry cleanup removes an approved review copy. */
    }
    return { status: 'reviewed', decision: data.decision };
  }
}
