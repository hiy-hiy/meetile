import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { requireCondition } from '../domain/errors';
import { containsContact } from '../domain/moderation';
import {
  adminCaseIdSchema,
  authorizeOperator,
  recordAudit,
} from './admin-moderation';

// Contact details stay in the external channel (L-02); the ledger never stores them.
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !containsContact(value), 'Contact details not allowed');
export const inquiryCategorySchema = z.enum([
  'general',
  'deletion',
  're-review',
  'rights',
  'child-safety',
  'other',
]);
export const inquiryIdSchema = z.uuid();
const resolutionSchema = z.enum([
  'answered',
  'action-taken',
  'no-action',
  'unable-to-verify',
]);
const requestId = z.uuid();
export const inquiryCreateSchema = z.strictObject({
  requestId,
  category: inquiryCategorySchema,
  externalRef: text(64).optional(),
  summary: text(1000),
  linkedCaseId: adminCaseIdSchema.optional(),
});
export const inquiryListSchema = z.strictObject({
  status: z.enum(['active', 'closed']).default('active'),
  cursor: inquiryIdSchema.optional(),
});
export const inquiryUpdateSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('assign'),
    id: inquiryIdSchema,
    requestId,
  }),
  z.strictObject({
    action: z.literal('note'),
    id: inquiryIdSchema,
    requestId,
    note: text(1000),
  }),
  z.strictObject({
    action: z.literal('link'),
    id: inquiryIdSchema,
    requestId,
    caseId: adminCaseIdSchema,
  }),
  z.strictObject({
    action: z.literal('close'),
    id: inquiryIdSchema,
    requestId,
    resolution: resolutionSchema,
    note: text(500),
  }),
]);
const inquirySchema = z.object({
  category: inquiryCategorySchema,
  externalRef: z.string().nullable(),
  summary: z.string(),
  status: z.enum(['open', 'in-progress', 'closed']),
  createdAtMs: z.number().int().nonnegative(),
  createdBy: z.string(),
  assigneeUid: z.string().nullable(),
  linkedCaseId: adminCaseIdSchema.nullable(),
  resolution: resolutionSchema.nullable(),
  resolutionNote: z.string().nullable(),
  closedAtMs: z.number().int().nonnegative().nullable(),
});
type Inquiry = z.infer<typeof inquirySchema>;
const noteSchema = z.object({
  note: z.string(),
  atMs: z.number().int().nonnegative(),
  authorUid: z.string(),
});
export interface AdminInquiry {
  id: string;
  category: Inquiry['category'];
  externalRef: string | null;
  summary: string;
  status: Inquiry['status'];
  createdAtMs: number;
  assigned: boolean;
  assignedToMe: boolean;
  linkedCaseId: string | null;
  resolution: Inquiry['resolution'];
  resolutionNote: string | null;
  closedAtMs: number | null;
}
export interface AdminInquiryDetail {
  inquiry: AdminInquiry;
  notes: { note: string; atMs: number; mine: boolean }[];
  moreNotes: boolean;
}
const inquiryPath = (id: string) =>
  `adminInquiries/${inquiryIdSchema.parse(id)}`;
function dto(id: string, value: Inquiry, uid: string): AdminInquiry {
  return {
    id,
    category: value.category,
    externalRef: value.externalRef,
    summary: value.summary,
    status: value.status,
    createdAtMs: value.createdAtMs,
    assigned: value.assigneeUid !== null,
    assignedToMe: value.assigneeUid === uid,
    linkedCaseId: value.linkedCaseId,
    resolution: value.resolution,
    resolutionNote: value.resolutionNote,
    closedAtMs: value.closedAtMs,
  };
}
// Deterministic UUID-shaped ID so a retried registration creates one entry.
function derivedId(uid: string, request: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['inquiry', uid, request]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Operator-maintained ledger of inquiries received through the external
 * channel (deletion requests, re-review requests, rights, child safety). It
 * holds no contact details and no safety IDs; actions on photos still go
 * through report cases. Admin server only.
 */
export class InquiryService {
  constructor(
    private readonly db: Firestore,
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
  private async requireCase(tx: Transaction, caseId: string) {
    requireCondition(
      (await tx.get(this.db.doc(`reports/${caseId}`))).exists,
      'not-found',
    );
  }
  async create(uid: string, input: unknown): Promise<{ id: string }> {
    const data = inquiryCreateSchema.parse(input);
    const id = derivedId(uid, data.requestId);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
    await this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      const ref = this.db.doc(inquiryPath(id));
      const existing = await tx.get(ref);
      if (existing.exists) {
        requireCondition(existing.get('fingerprint') === fingerprint);
        return;
      }
      if (data.linkedCaseId) await this.requireCase(tx, data.linkedCaseId);
      tx.create(ref, {
        category: data.category,
        externalRef: data.externalRef ?? null,
        summary: data.summary,
        status: 'open',
        createdAtMs: this.clock(),
        createdBy: uid,
        assigneeUid: null,
        linkedCaseId: data.linkedCaseId ?? null,
        resolution: null,
        resolutionNote: null,
        closedAtMs: null,
        fingerprint,
      });
      this.audit(tx, uid, 'create-inquiry', id, `inquiry-${id}`);
    });
    return { id };
  }
  async list(
    uid: string,
    input: unknown,
  ): Promise<{ inquiries: AdminInquiry[]; nextCursor: string | null }> {
    const data = inquiryListSchema.parse(input);
    return this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      let query = this.db
        .collection('adminInquiries')
        .where(
          'status',
          'in',
          data.status === 'closed' ? ['closed'] : ['open', 'in-progress'],
        )
        .orderBy('__name__')
        .limit(26);
      if (data.cursor) query = query.startAfter(data.cursor);
      const docs = await tx.get(query);
      const inquiries = docs.docs
        .slice(0, 25)
        .map((doc) => dto(doc.id, inquirySchema.parse(doc.data()), uid));
      this.audit(tx, uid, 'list-inquiries', null);
      return {
        inquiries,
        nextCursor: docs.size > 25 ? (inquiries.at(-1)?.id ?? null) : null,
      };
    });
  }
  async detail(uid: string, inquiryId: string): Promise<AdminInquiryDetail> {
    const id = inquiryIdSchema.parse(inquiryId);
    return this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      const doc = await tx.get(this.db.doc(inquiryPath(id)));
      requireCondition(doc.exists, 'not-found');
      const notes = await tx.get(
        this.db
          .collection(`${inquiryPath(id)}/notes`)
          .orderBy('atMs')
          .limit(51),
      );
      this.audit(tx, uid, 'view-inquiry', id);
      return {
        inquiry: dto(id, inquirySchema.parse(doc.data()), uid),
        notes: notes.docs.slice(0, 50).map((note) => {
          const value = noteSchema.parse(note.data());
          return {
            note: value.note,
            atMs: value.atMs,
            mine: value.authorUid === uid,
          };
        }),
        moreNotes: notes.size > 50,
      };
    });
  }
  async update(uid: string, input: unknown): Promise<{ status: 'recorded' }> {
    const data = inquiryUpdateSchema.parse(input);
    const receiptId = createHash('sha256')
      .update(JSON.stringify(['inquiry-update', uid, data.requestId]))
      .digest('hex');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
    await this.db.runTransaction(async (tx) => {
      await authorizeOperator(this.db, tx, uid);
      const receiptRef = this.db.doc(`adminInquiryReceipts/${receiptId}`);
      const receipt = await tx.get(receiptRef);
      if (receipt.exists) {
        requireCondition(receipt.get('fingerprint') === fingerprint);
        return;
      }
      const ref = this.db.doc(inquiryPath(data.id));
      const doc = await tx.get(ref);
      requireCondition(doc.exists, 'not-found');
      const inquiry = inquirySchema.parse(doc.data());
      // A closed inquiry is final; a later contact becomes a new entry.
      requireCondition(inquiry.status !== 'closed');
      const atMs = this.clock();
      if (data.action === 'assign')
        tx.update(ref, { assigneeUid: uid, status: 'in-progress' });
      else if (data.action === 'note')
        tx.create(this.db.doc(`${inquiryPath(data.id)}/notes/${receiptId}`), {
          note: data.note,
          atMs,
          authorUid: uid,
        });
      else if (data.action === 'link') {
        // Linking never replaces an earlier link; it only points at a report case.
        requireCondition(inquiry.linkedCaseId === null);
        await this.requireCase(tx, data.caseId);
        tx.update(ref, { linkedCaseId: data.caseId });
      } else
        tx.update(ref, {
          status: 'closed',
          resolution: data.resolution,
          resolutionNote: data.note,
          closedAtMs: atMs,
        });
      tx.create(receiptRef, { fingerprint, id: data.id, atMs });
      // Reassignment is allowed; the audit records who took the inquiry.
      this.audit(tx, uid, `${data.action}-inquiry`, data.id, receiptId);
    });
    return { status: 'recorded' };
  }
}
