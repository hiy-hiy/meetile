import type {
  Firestore,
  Transaction,
  DocumentReference,
} from 'firebase-admin/firestore';
import { requireCondition } from '../domain/errors';
import {
  mediaAccessSchema,
  pieceSchema,
  subjectSchema,
  type Subject,
  type PrivatePiece,
  boardSchema,
  dailySchema,
} from '../domain/models';
import { paths } from '../repositories/paths';
import { readModel } from '../repositories/documents';
import { blockPhotoSchema, boardViewSchema } from '@puzzle-sns/contracts';

/** Private safety state; user operations resolve ownership and membership on the server. */
export class SafetyFoundation {
  constructor(private readonly db: Firestore) {}
  private increment(tx: Transaction, uid: string, subject: Subject): void {
    requireCondition(Number.isSafeInteger(subject.accessEpoch + 1));
    tx.update(this.db.doc(paths.subject(uid)), {
      accessEpoch: subject.accessEpoch + 1,
    });
    // An ended subject has no client; never recreate its deleted client state.
    if (subject.status !== 'ended')
      tx.set(
        this.db.doc(paths.clientState(uid)),
        { accessRevision: subject.accessEpoch + 1 },
        { merge: true },
      );
  }
  async block(a: string, b: string): Promise<void> {
    requireCondition(a !== b, 'invalid-argument');
    await this.db.runTransaction((tx) => this.writeBlock(tx, a, b));
  }
  async blockPhoto(
    uid: string,
    input: unknown,
  ): Promise<{ status: 'blocked' }> {
    const { pieceId } = blockPhotoSchema.parse(input);
    await this.db.runTransaction(async (tx) => {
      const caller = await readModel(
        this.db,
        tx,
        paths.subject(uid),
        subjectSchema,
      );
      requireCondition(caller.status === 'active', 'permission-denied');
      const pieceDoc = await tx.get(this.db.doc(paths.piece(pieceId)));
      requireCondition(pieceDoc.exists, 'permission-denied');
      const piece = pieceSchema.parse(pieceDoc.data());
      requireCondition(piece.ownerUid !== uid, 'permission-denied');
      const membership = await tx.get(
        this.db.doc(paths.daily(piece.dayKey, uid)),
      );
      requireCondition(membership.exists, 'permission-denied');
      const daily = dailySchema.parse(membership.data());
      const board = await readModel(
        this.db,
        tx,
        paths.board(daily.boardId),
        boardSchema,
      );
      requireCondition(
        board.status === 'active' &&
          board.dayKey === piece.dayKey &&
          board.members.some(
            (member) =>
              member.uid === uid &&
              member.pieceId === daily.pieceId &&
              member.participantKey === daily.participantKey,
          ) &&
          board.members.some(
            (member) =>
              member.uid === piece.ownerUid && member.pieceId === pieceId,
          ),
        'permission-denied',
      );
      await this.writeBlock(tx, uid, piece.ownerUid);
    });
    return { status: 'blocked' };
  }
  private async writeBlock(
    tx: Transaction,
    a: string,
    b: string,
  ): Promise<void> {
    const blockRef = this.db.doc(paths.block(a, b));
    const existing = await tx.get(blockRef);
    const first = await readModel(this.db, tx, paths.subject(a), subjectSchema);
    const second = await readModel(
      this.db,
      tx,
      paths.subject(b),
      subjectSchema,
    );
    if (existing.exists) return;
    // Global epochs close all old views and media grants for both subjects,
    // including earlier days. Resync consults the private pair before granting
    // access again; no unbounded historical fan-out is needed in this transaction.
    tx.create(blockRef, { blocked: true });
    this.increment(tx, a, first);
    this.increment(tx, b, second);
  }
  async hideReportedPiece(viewer: string, pieceId: string): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.doc(paths.hidden(viewer, pieceId));
      const existing = await tx.get(ref);
      const subject = await readModel(
        this.db,
        tx,
        paths.subject(viewer),
        subjectSchema,
      );
      await readModel(this.db, tx, paths.piece(pieceId), pieceSchema);
      if (existing.exists) return;
      tx.create(ref, { hidden: true });
      this.increment(tx, viewer, subject);
    });
  }
  async removePiece(
    pieceId: string,
    state: 'deleted' | 'removed' = 'deleted',
    ownerUid?: string,
  ): Promise<void> {
    await this.db.runTransaction((tx) =>
      this.removePieceInTransaction(tx, pieceId, state, ownerUid),
    );
  }
  /** Server-only composition with moderation decision and audit in the same commit. */
  async removePieceInTransaction(
    tx: Transaction,
    pieceId: string,
    state: 'deleted' | 'removed',
    ownerUid?: string,
    scrubCopies = ownerUid !== undefined,
  ): Promise<void> {
    const piece = await readModel(
      this.db,
      tx,
      paths.piece(pieceId),
      pieceSchema,
    );
    if (ownerUid !== undefined) {
      requireCondition(piece.ownerUid === ownerUid, 'permission-denied');
      const owner = await readModel(
        this.db,
        tx,
        paths.subject(ownerUid),
        subjectSchema,
      );
      requireCondition(owner.status === 'active', 'permission-denied');
    }
    const media = await readModel(
      this.db,
      tx,
      paths.media(pieceId),
      mediaAccessSchema,
    );
    if (piece.status !== 'approved' && !media.visible && !scrubCopies) return;
    // The authenticated deletion also removes searchable copies in capture,
    // approval and historical display documents. Geometry is never rewritten.
    const copies = scrubCopies
      ? await this.deletionCopies(tx, pieceId, piece)
      : null;
    const audience = Object.keys(media.epochs);
    requireCondition(audience.length <= 20);
    const snapshots = audience.length
      ? await tx.getAll(
          ...audience.map((uid) => this.db.doc(paths.subject(uid))),
        )
      : [];
    const subjects = snapshots.map((snapshot) => ({
      uid: snapshot.id,
      value: snapshot.exists ? subjectSchema.parse(snapshot.data()) : null,
    }));
    // Global image gate and every currently authorized viewer's projections close atomically.
    tx.update(this.db.doc(paths.piece(pieceId)), {
      status: piece.status === 'approved' ? state : piece.status,
      username: null,
      caption: null,
    });
    tx.set(this.db.doc(paths.media(pieceId)), { visible: false, epochs: {} });
    for (const subject of subjects)
      if (subject.value) this.increment(tx, subject.uid, subject.value);
    tx.set(this.db.doc(`deletionJobs/${pieceId}`), {
      objectPath: `normalized/${pieceId}/image`,
      status: 'pending',
      attemptCount: 0,
      ...(copies ? { rawPaths: copies.rawPaths } : {}),
    });
    for (const copy of copies?.captures ?? [])
      tx.update(copy.ref, { username: null, caption: null });
    for (const copy of copies?.approvals ?? [])
      tx.update(copy.ref, { username: '', caption: '' });
    for (const copy of copies?.views ?? [])
      tx.set(copy.ref, {
        ...copy.view,
        pieces: copy.view.pieces.map((value) =>
          value.id === pieceId
            ? {
                ...value,
                visibility: 'blank',
                photoRef: null,
                username: null,
                caption: null,
              }
            : value,
        ),
      });
  }
  async removeOwnPiece(uid: string, pieceId: string): Promise<void> {
    await this.removePiece(pieceId, 'deleted', uid);
  }
  private async deletionCopies(
    tx: Transaction,
    pieceId: string,
    piece: PrivatePiece,
  ) {
    const membership = await readModel(
      this.db,
      tx,
      paths.daily(piece.dayKey, piece.ownerUid),
      dailySchema,
    );
    requireCondition(membership.pieceId === pieceId);
    const [captures, approvals, boards] = await Promise.all([
      tx.get(
        this.db.collection('captures').where('pieceId', '==', pieceId).limit(2),
      ),
      tx.get(
        this.db
          .collection('approvals')
          .where('normalizedPieceId', '==', pieceId)
          .limit(2),
      ),
      tx.get(
        this.db
          .collection('boards')
          .where(
            'geometry.participantKeys',
            'array-contains',
            membership.participantKey,
          )
          .limit(21),
      ),
    ]);
    requireCondition(
      captures.size <= 1 && approvals.size <= 1 && boards.size <= 20,
    );
    const refs = new Map<string, DocumentReference>();
    for (const doc of boards.docs) {
      const board = boardSchema.parse(doc.data());
      requireCondition(
        board.dayKey === piece.dayKey &&
          board.members.some(
            (m) => m.uid === piece.ownerUid && m.pieceId === pieceId,
          ),
      );
      for (const member of board.members) {
        const path = paths.view(member.uid, doc.id);
        refs.set(path, this.db.doc(path));
      }
    }
    const snapshots = refs.size ? await tx.getAll(...refs.values()) : [];
    return {
      captures: captures.docs,
      approvals: approvals.docs,
      rawPaths: captures.docs.map((doc) => `pending/${doc.id}/image`),
      views: snapshots
        .filter((doc) => doc.exists)
        .map((doc) => ({
          ref: doc.ref,
          view: boardViewSchema.parse(doc.data()),
        })),
    };
  }
  async setSubjectStatus(
    uid: string,
    status: 'suspended' | 'ended',
  ): Promise<void> {
    await this.db.runTransaction((tx) =>
      this.setSubjectStatusInTransaction(tx, uid, status),
    );
  }
  /** Server-only composition with an operator's reason, receipt and audit. */
  async setSubjectStatusInTransaction(
    tx: Transaction,
    uid: string,
    status: 'suspended' | 'ended',
  ): Promise<void> {
    const subject = await readModel(
      this.db,
      tx,
      paths.subject(uid),
      subjectSchema,
    );
    if (subject.status === status) return;
    this.increment(tx, uid, subject);
    tx.update(this.db.doc(paths.subject(uid)), { status });
    // No logging of UID, image content or relationship information.
  }
}
