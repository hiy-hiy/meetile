import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import {
  dayKeySchema,
  documentIdSchema,
  reportReasonSchema,
} from '@puzzle-sns/contracts';
import { requireCondition } from '../domain/errors';
import {
  pieceSchema,
  mediaAccessSchema,
  subjectSchema,
} from '../domain/models';
import { paths } from '../repositories/paths';
import { SafetyFoundation } from './safety';

export const adminCaseIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const adminListSchema = z.strictObject({
  status: z.enum(['pending', 'reviewed']).default('pending'),
  cursor: adminCaseIdSchema.optional(),
});
export const adminDecisionSchema = z.strictObject({
  caseId: adminCaseIdSchema,
  requestId: z.uuid(),
  decision: z.enum(['dismiss', 'remove']),
  note: z.string().trim().min(1).max(500),
});
export const adminSuspensionSchema = z.strictObject({
  caseId: adminCaseIdSchema,
  requestId: z.uuid(),
  note: z.string().trim().min(1).max(500),
});
export const adminReReviewSchema = z.strictObject({
  caseId: adminCaseIdSchema,
  requestId: z.uuid(),
  target: z.enum(['decision', 'suspension']),
  outcome: z.enum(['upheld', 'overturned']),
  note: z.string().trim().min(1).max(500),
});
const suspensionSummarySchema = z.strictObject({
  note: z.string().min(1).max(500),
  atMs: z.number().int().nonnegative(),
  changed: z.boolean(),
  // Private: lets a re-review exclude the operator who suspended (never in DTOs).
  operatorUid: z.string().optional(),
});
const reReviewSchema = z.object({
  outcome: z.enum(['upheld', 'overturned']),
  note: z.string().min(1).max(500),
  atMs: z.number().int().nonnegative(),
  original: z.enum(['dismiss', 'remove', 'suspension']),
  effect: z.enum(['none', 'removed']),
});
export type AdminReReview = z.infer<typeof reReviewSchema>;
const reportSchema = z.object({
  pieceId: documentIdSchema,
  dayKey: dayKeySchema,
  reason: reportReasonSchema,
  status: z.enum(['pending', 'reviewed']),
  createdAtMs: z.number().int().nonnegative(),
  decision: z.enum(['dismiss', 'remove']).optional(),
  reviewedAtMs: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});
export type AdminReport = z.infer<typeof reportSchema> & { caseId: string };
export interface AdminReportDetail {
  report: AdminReport;
  photoState: 'approved' | 'deleted' | 'removed' | 'missing';
  username: string | null;
  caption: string | null;
  related: AdminReport[];
  moreRelated: boolean;
  subjectState: 'active' | 'suspended' | 'ended' | 'missing';
  suspension: { note: string; atMs: number; changed: boolean } | null;
  reReviews: {
    decision: AdminReReview | null;
    suspension: AdminReReview | null;
  };
  /** True when the viewing operator made the original action (no self re-review). */
  ownDecision: boolean;
  ownSuspension: boolean;
}
const reReviewPath = (caseId: string, target: 'decision' | 'suspension') =>
  `adminReReviews/${createHash('sha256')
    .update(JSON.stringify([adminCaseIdSchema.parse(caseId), target]))
    .digest('hex')}`;
const operatorId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('/'));
const operatorPath = (uid: string) => `adminOperators/${operatorId.parse(uid)}`;
/** Every admin read and write rechecks the server-side allowlist in its own transaction. */
export async function authorizeOperator(
  db: Firestore,
  tx: Transaction,
  uid: string,
): Promise<void> {
  const operator = await tx.get(db.doc(operatorPath(uid)));
  requireCondition(
    operator.exists && operator.get('enabled') === true,
    'permission-denied',
  );
}
/** Audit entries never copy photos, texts or tokens. */
export function recordAudit(
  db: Firestore,
  tx: Transaction,
  entry: { uid: string; action: string; caseId: string | null; atMs: number },
  id: string = randomUUID(),
): void {
  tx.create(db.doc(`adminAudit/${id}`), {
    operatorUid: entry.uid,
    action: entry.action,
    caseId: entry.caseId,
    atMs: entry.atMs,
  });
}

/** This service is used only by the authenticated admin server, never by mobile Callables. */
export class AdminModerationService {
  constructor(
    private readonly db: Firestore,
    private readonly clock: () => number = Date.now,
  ) {}
  private async authorize(tx: Transaction, uid: string) {
    await authorizeOperator(this.db, tx, uid);
  }
  private audit(
    tx: Transaction,
    uid: string,
    action: string,
    caseId: string | null,
    id: string = randomUUID(),
  ) {
    recordAudit(this.db, tx, { uid, action, caseId, atMs: this.clock() }, id);
  }
  async access(
    uid: string,
    action: 'login' | 'logout' | 'session-check',
  ): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      this.audit(tx, uid, action, null);
    });
  }
  async beginSession(
    uid: string,
    hash: string,
    expiresAtMs: number,
    runId: string | null,
  ): Promise<void> {
    adminCaseIdSchema.parse(hash);
    await this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      tx.set(this.db.doc(`adminSessions/${hash}`), {
        uid,
        expiresAtMs,
        runId,
        expireAt: Timestamp.fromMillis(expiresAtMs),
      });
      this.audit(tx, uid, 'login', null);
    });
  }
  async endSession(uid: string, hash: string): Promise<void> {
    adminCaseIdSchema.parse(hash);
    await this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      const sessionRef = this.db.doc(`adminSessions/${hash}`);
      const session = await tx.get(sessionRef);
      requireCondition(
        session.exists && session.get('uid') === uid,
        'permission-denied',
      );
      tx.delete(sessionRef);
      this.audit(tx, uid, 'logout', null);
    });
  }
  async list(
    uid: string,
    input: unknown,
  ): Promise<{ reports: AdminReport[]; nextCursor: string | null }> {
    const data = adminListSchema.parse(input);
    return this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      let query = this.db
        .collection('reports')
        .where('status', '==', data.status)
        .orderBy('__name__')
        .limit(26);
      if (data.cursor) query = query.startAfter(data.cursor);
      const docs = await tx.get(query);
      const reports = docs.docs.slice(0, 25).map((doc) => ({
        ...reportSchema.parse(doc.data()),
        caseId: adminCaseIdSchema.parse(doc.id),
      }));
      this.audit(tx, uid, 'list-reports', null);
      return {
        reports,
        nextCursor: docs.size > 25 ? (reports.at(-1)?.caseId ?? null) : null,
      };
    });
  }
  async detail(uid: string, caseId: string): Promise<AdminReportDetail> {
    adminCaseIdSchema.parse(caseId);
    return this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      const doc = await tx.get(this.db.doc(`reports/${caseId}`));
      requireCondition(doc.exists, 'not-found');
      const report = { ...reportSchema.parse(doc.data()), caseId };
      const [pieceDoc, related] = await Promise.all([
        tx.get(this.db.doc(paths.piece(report.pieceId))),
        tx.get(
          this.db
            .collection('reports')
            .where('pieceId', '==', report.pieceId)
            .limit(21),
        ),
      ]);
      const piece = pieceDoc.exists ? pieceSchema.parse(pieceDoc.data()) : null;
      const [subjectDoc, suspensionDoc, decisionReview, suspensionReview] =
        await Promise.all([
          piece
            ? tx.get(this.db.doc(paths.subject(piece.ownerUid)))
            : Promise.resolve(null),
          tx.get(this.db.doc(`adminCaseSuspensions/${caseId}`)),
          tx.get(this.db.doc(reReviewPath(caseId, 'decision'))),
          tx.get(this.db.doc(reReviewPath(caseId, 'suspension'))),
        ]);
      const summary = suspensionDoc.exists
        ? suspensionSummarySchema.parse(suspensionDoc.data())
        : null;
      const suspender = summary
        ? await this.suspensionOperator(tx, caseId, summary)
        : null;
      this.audit(tx, uid, 'view-report', caseId);
      return {
        report,
        photoState: piece?.status ?? 'missing',
        username: piece?.status === 'approved' ? piece.username : null,
        caption: piece?.status === 'approved' ? piece.caption : null,
        related: related.docs.slice(0, 20).map((doc) => ({
          ...reportSchema.parse(doc.data()),
          caseId: adminCaseIdSchema.parse(doc.id),
        })),
        moreRelated: related.size > 20,
        subjectState: subjectDoc?.exists
          ? subjectSchema.parse(subjectDoc.data()).status
          : 'missing',
        suspension: summary
          ? { note: summary.note, atMs: summary.atMs, changed: summary.changed }
          : null,
        reReviews: {
          decision: decisionReview.exists
            ? reReviewSchema.parse(decisionReview.data())
            : null,
          suspension: suspensionReview.exists
            ? reReviewSchema.parse(suspensionReview.data())
            : null,
        },
        ownDecision: doc.get('reviewerUid') === uid,
        ownSuspension: suspender === uid,
      };
    });
  }
  /** Suspensions before re-review support recorded the operator only in the audit log. */
  private async suspensionOperator(
    tx: Transaction,
    caseId: string,
    summary: z.infer<typeof suspensionSummarySchema>,
  ): Promise<string | null> {
    if (summary.operatorUid) return summary.operatorUid;
    const audit = await tx.get(
      this.db.collection('adminAudit').where('caseId', '==', caseId),
    );
    const entry = audit.docs.find((doc) =>
      ['suspend-user', 'confirm-suspension'].includes(
        String(doc.get('action')),
      ),
    );
    const operator: unknown = entry?.get('operatorUid');
    return typeof operator === 'string' ? operator : null;
  }
  /**
   * A second operator's review of an earlier decision or suspension. It never
   * overwrites the original record. The only state change is strengthening: a
   * dismissal found wrong removes the photo. A removal cannot be undone (the
   * image is deleted) and a suspension is not lifted; both are recorded only.
   */
  async reReview(
    uid: string,
    input: unknown,
  ): Promise<{ status: 'recorded'; effect: 'none' | 'removed' }> {
    const data = adminReReviewSchema.parse(input);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
    const ref = this.db.doc(reReviewPath(data.caseId, data.target));
    return this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      const existing = await tx.get(ref);
      if (existing.exists) {
        // One review per target; only the identical request may be retried.
        requireCondition(existing.get('fingerprint') === fingerprint);
        return {
          status: 'recorded',
          effect: reReviewSchema.parse(existing.data()).effect,
        };
      }
      const reportDoc = await tx.get(this.db.doc(`reports/${data.caseId}`));
      requireCondition(reportDoc.exists, 'not-found');
      const report = reportSchema.parse(reportDoc.data());
      let original: AdminReReview['original'];
      let originalOperator: unknown;
      if (data.target === 'decision') {
        requireCondition(report.status === 'reviewed' && !!report.decision);
        original = report.decision!;
        originalOperator = reportDoc.get('reviewerUid');
      } else {
        const summaryDoc = await tx.get(
          this.db.doc(`adminCaseSuspensions/${data.caseId}`),
        );
        requireCondition(summaryDoc.exists, 'not-found');
        original = 'suspension';
        originalOperator = await this.suspensionOperator(
          tx,
          data.caseId,
          suspensionSummarySchema.parse(summaryDoc.data()),
        );
      }
      requireCondition(
        typeof originalOperator === 'string' && originalOperator !== uid,
        'permission-denied',
      );
      const effect =
        original === 'dismiss' && data.outcome === 'overturned'
          ? 'removed'
          : 'none';
      if (effect === 'removed')
        await new SafetyFoundation(this.db).removePieceInTransaction(
          tx,
          report.pieceId,
          'removed',
          undefined,
          true,
        );
      const atMs = this.clock();
      tx.create(ref, {
        caseId: data.caseId,
        target: data.target,
        outcome: data.outcome,
        note: data.note,
        atMs,
        original,
        effect,
        reviewerUid: uid,
        fingerprint,
      });
      this.audit(
        tx,
        uid,
        `rereview-${data.target}-${data.outcome}`,
        data.caseId,
        createHash('sha256')
          .update(JSON.stringify(['rereview', data.caseId, data.target]))
          .digest('hex'),
      );
      return { status: 'recorded', effect };
    });
  }
  async imageTarget(uid: string, caseId: string): Promise<string> {
    adminCaseIdSchema.parse(caseId);
    return this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      const doc = await tx.get(this.db.doc(`reports/${caseId}`));
      requireCondition(doc.exists, 'not-found');
      const report = reportSchema.parse(doc.data());
      const [piece, media] = await Promise.all([
        tx.get(this.db.doc(paths.piece(report.pieceId))),
        tx.get(this.db.doc(paths.media(report.pieceId))),
      ]);
      requireCondition(
        piece.exists &&
          media.exists &&
          pieceSchema.parse(piece.data()).status === 'approved' &&
          mediaAccessSchema.parse(media.data()).visible,
        'not-found',
      );
      this.audit(tx, uid, 'view-image', caseId);
      return `normalized/${report.pieceId}/image`;
    });
  }
  async decide(uid: string, input: unknown): Promise<{ status: 'reviewed' }> {
    const data = adminDecisionSchema.parse(input);
    const receiptId = createHash('sha256')
      .update(JSON.stringify([uid, data.requestId]))
      .digest('hex');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
    await this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      const receiptRef = this.db.doc(`adminDecisions/${receiptId}`);
      const receipt = await tx.get(receiptRef);
      if (receipt.exists) {
        requireCondition(receipt.get('fingerprint') === fingerprint);
        return;
      }
      const ref = this.db.doc(`reports/${data.caseId}`);
      const doc = await tx.get(ref);
      requireCondition(doc.exists, 'not-found');
      const report = reportSchema.parse(doc.data());
      requireCondition(report.status === 'pending');
      if (data.decision === 'remove')
        await new SafetyFoundation(this.db).removePieceInTransaction(
          tx,
          report.pieceId,
          'removed',
          undefined,
          true,
        );
      tx.update(ref, {
        status: 'reviewed',
        decision: data.decision,
        note: data.note,
        reviewedAtMs: this.clock(),
        reviewerUid: uid,
      });
      tx.create(receiptRef, {
        fingerprint,
        caseId: data.caseId,
        decision: data.decision,
        atMs: this.clock(),
      });
      this.audit(
        tx,
        uid,
        data.decision === 'remove' ? 'remove-photo' : 'dismiss-report',
        data.caseId,
        receiptId,
      );
    });
    return { status: 'reviewed' };
  }
  async suspend(uid: string, input: unknown): Promise<{ status: 'suspended' }> {
    const data = adminSuspensionSchema.parse(input);
    const receiptId = createHash('sha256')
      .update(JSON.stringify(['suspend', uid, data.requestId]))
      .digest('hex');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
    await this.db.runTransaction(async (tx) => {
      await this.authorize(tx, uid);
      const receiptRef = this.db.doc(`adminSuspensions/${receiptId}`);
      const receipt = await tx.get(receiptRef);
      if (receipt.exists) {
        requireCondition(receipt.get('fingerprint') === fingerprint);
        return;
      }
      const report = await tx.get(this.db.doc(`reports/${data.caseId}`));
      requireCondition(report.exists, 'not-found');
      const parsed = reportSchema.parse(report.data());
      const pieceDoc = await tx.get(this.db.doc(paths.piece(parsed.pieceId)));
      requireCondition(pieceDoc.exists, 'not-found');
      const piece = pieceSchema.parse(pieceDoc.data());
      const subjectDoc = await tx.get(
        this.db.doc(paths.subject(piece.ownerUid)),
      );
      requireCondition(subjectDoc.exists, 'not-found');
      const subject = subjectSchema.parse(subjectDoc.data());
      requireCondition(subject.status !== 'ended');
      const summaryRef = this.db.doc(`adminCaseSuspensions/${data.caseId}`);
      const summary = await tx.get(summaryRef);
      requireCondition(!summary.exists);
      const changed = subject.status === 'active';
      await new SafetyFoundation(this.db).setSubjectStatusInTransaction(
        tx,
        piece.ownerUid,
        'suspended',
      );
      const atMs = this.clock();
      tx.create(summaryRef, {
        note: data.note,
        atMs,
        changed,
        operatorUid: uid,
      });
      tx.create(receiptRef, {
        fingerprint,
        caseId: data.caseId,
        note: data.note,
        atMs,
        changed,
      });
      this.audit(
        tx,
        uid,
        changed ? 'suspend-user' : 'confirm-suspension',
        data.caseId,
        receiptId,
      );
    });
    return { status: 'suspended' };
  }
}
