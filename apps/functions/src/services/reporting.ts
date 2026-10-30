import type { Firestore } from 'firebase-admin/firestore';
import { boardViewSchema, reportPhotoSchema } from '@puzzle-sns/contracts';
import {
  boardSchema,
  dailySchema,
  mediaAccessSchema,
  pieceSchema,
  subjectSchema,
} from '../domain/models';
import { readModel } from '../repositories/documents';
import { paths } from '../repositories/paths';
import { requireCondition } from '../domain/errors';

export class ReportingService {
  constructor(
    private readonly db: Firestore,
    private readonly clock: () => number = Date.now,
  ) {}
  async report(uid: string, input: unknown): Promise<{ status: 'reported' }> {
    const data = reportPhotoSchema.parse(input);
    await this.db.runTransaction(async (tx) => {
      const subject = await readModel(
        this.db,
        tx,
        paths.subject(uid),
        subjectSchema,
      );
      requireCondition(subject.status === 'active', 'permission-denied');
      const reportRef = this.db.doc(paths.report(uid, data.pieceId));
      const existing = await tx.get(reportRef);
      // An accepted report remains an idempotent receipt after later deletion,
      // moderation or membership changes. It never returns private contents.
      if (existing.exists) {
        requireCondition(
          existing.get('reporterUid') === uid &&
            existing.get('pieceId') === data.pieceId,
          'permission-denied',
        );
        return;
      }
      const pieceDoc = await tx.get(this.db.doc(paths.piece(data.pieceId)));
      requireCondition(pieceDoc.exists, 'permission-denied');
      const piece = pieceSchema.parse(pieceDoc.data());
      requireCondition(piece.ownerUid !== uid, 'permission-denied');
      const dailyDoc = await tx.get(
        this.db.doc(paths.daily(piece.dayKey, uid)),
      );
      requireCondition(dailyDoc.exists, 'permission-denied');
      const daily = dailySchema.parse(dailyDoc.data());
      const current = await readModel(
        this.db,
        tx,
        paths.board(daily.boardId),
        boardSchema,
      );
      requireCondition(
        current.status === 'active' &&
          current.dayKey === piece.dayKey &&
          current.members.some(
            (member) =>
              member.uid === uid &&
              member.pieceId === daily.pieceId &&
              member.participantKey === daily.participantKey,
          ) &&
          current.members.some(
            (member) =>
              member.uid === piece.ownerUid && member.pieceId === data.pieceId,
          ),
        'permission-denied',
      );
      const media = await readModel(
        this.db,
        tx,
        paths.media(data.pieceId),
        mediaAccessSchema,
      );
      const history = await tx.get(
        this.db
          .collection('boards')
          .where(
            'geometry.participantKeys',
            'array-contains',
            daily.participantKey,
          )
          .limit(21),
      );
      requireCondition(history.size <= 20);
      const refs = history.docs.map((doc) => {
        const board = boardSchema.parse(doc.data());
        requireCondition(
          board.dayKey === piece.dayKey &&
            board.members.some(
              (member) =>
                member.uid === uid &&
                member.participantKey === daily.participantKey,
            ),
        );
        return this.db.doc(paths.view(uid, doc.id));
      });
      const copies = refs.length ? await tx.getAll(...refs) : [];
      requireCondition(Number.isSafeInteger(subject.accessEpoch + 1));
      tx.create(reportRef, {
        reporterUid: uid,
        pieceId: data.pieceId,
        reason: data.reason,
        dayKey: piece.dayKey,
        status: 'pending',
        createdAtMs: this.clock(),
      });
      tx.set(this.db.doc(paths.hidden(uid, data.pieceId)), { hidden: true });
      tx.update(this.db.doc(paths.subject(uid)), {
        accessEpoch: subject.accessEpoch + 1,
      });
      tx.set(
        this.db.doc(paths.clientState(uid)),
        { accessRevision: subject.accessEpoch + 1 },
        { merge: true },
      );
      const epochs = { ...media.epochs };
      delete epochs[uid];
      tx.set(this.db.doc(paths.media(data.pieceId)), {
        visible: media.visible,
        epochs,
      });
      for (const copy of copies) {
        if (!copy.exists) continue;
        const view = boardViewSchema.parse(copy.data());
        tx.set(copy.ref, {
          ...view,
          pieces: view.pieces.map((piece) =>
            piece.id === data.pieceId
              ? {
                  ...piece,
                  visibility: 'blank',
                  photoRef: null,
                  username: null,
                  caption: null,
                }
              : piece,
          ),
        });
      }
    });
    return { status: 'reported' };
  }
}
