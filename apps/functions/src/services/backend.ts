import { privateCaptureSchema } from '../domain/capture';
import { randomInt, randomUUID } from 'node:crypto';
import {
  Timestamp,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  dayStateSchema,
  galleryListSchema,
  type BoardView,
  type GalleryList,
  type DayState,
  type FitOutcome,
} from '@puzzle-sns/contracts';
import { generatePiece, mergeBoards } from '@puzzle-sns/puzzle-engine';
import { requireCondition } from '../domain/errors';
import {
  approvalSchema,
  boardSchema,
  dailySchema,
  pieceSchema,
  sessionSchema,
  subjectSchema,
  type CanonicalBoard,
} from '../domain/models';
import { dayKeyAt } from '../domain/time';
import { mergeIdentity } from '../domain/seed';
import { paths } from '../repositories/paths';
import { readModel } from '../repositories/documents';
import { loadProjectionState, writeProjections } from './projections';
import { writeFitViews } from './fit-views';

/** A held capture approved by an operator; its decision commits with the publication. */
export interface HeldPublication {
  captureId: string;
  /** Reads only: runs before any write of the publication transaction. */
  verify(tx: Transaction): Promise<void>;
  record(tx: Transaction): void;
}
export class Backend {
  constructor(
    private readonly db: Firestore,
    private readonly clock: () => number = Date.now,
  ) {}

  private assertFresh(dayKey: string, expiresAtMs = Infinity): void {
    const now = this.clock();
    requireCondition(dayKeyAt(now) === dayKey && now < expiresAtMs);
  }

  async getDayState(uid: string): Promise<DayState> {
    return this.db.runTransaction(async (tx) => {
      const now = this.clock();
      const dayKey = dayKeyAt(now);
      const subjectRef = this.db.doc(paths.subject(uid));
      const snapshot = await tx.get(subjectRef);
      if (snapshot.exists)
        requireCondition(
          subjectSchema.parse(snapshot.data()).status === 'active',
          'permission-denied',
        );
      const daily = await tx.get(this.db.doc(paths.daily(dayKey, uid)));
      const membership = daily.exists ? dailySchema.parse(daily.data()) : null;
      const piece = membership
        ? await readModel(
            this.db,
            tx,
            paths.piece(membership.pieceId),
            pieceSchema,
          )
        : null;
      this.assertFresh(dayKey);
      if (!snapshot.exists)
        tx.create(subjectRef, { status: 'active', accessEpoch: 0 });
      tx.set(this.db.doc(paths.clientState(uid)), {
        dayKey,
        boardId: membership?.boardId ?? null,
        accessRevision: snapshot.exists
          ? subjectSchema.parse(snapshot.data()).accessEpoch
          : 0,
      });
      return dayStateSchema.parse({
        dayKey,
        serverTimeMs: now,
        ownPieceId: membership?.pieceId ?? null,
        boardId: membership?.boardId ?? null,
        photoState: !piece
          ? 'not-created'
          : piece.status === 'approved'
            ? 'ready'
            : 'unavailable',
      });
    });
  }

  /** Trusted moderation pipeline only. Deliberately not exported as a callable. */
  async publishApprovedPiece(
    approvalId: string,
    captureLease?: { captureId: string; token: string },
    held?: HeldPublication,
  ): Promise<{ pieceId: string; boardId: string }> {
    requireCondition(!(captureLease && held));
    const participantKey = randomUUID();
    const boardId = randomUUID();
    const generated = generatePiece('temporary', () => randomInt(4) / 4);
    return this.db.runTransaction(async (tx) => {
      const dayKey = dayKeyAt(this.clock());
      const approval = await readModel(
        this.db,
        tx,
        paths.approval(approvalId),
        approvalSchema,
      );
      requireCondition(
        approval.status === 'approved' && approval.dayKey === dayKey,
      );
      const subject = await readModel(
        this.db,
        tx,
        paths.subject(approval.ownerUid),
        subjectSchema,
      );
      requireCondition(subject.status === 'active', 'permission-denied');
      const dailyRef = this.db.doc(paths.daily(dayKey, approval.ownerUid));
      const existing = await tx.get(dailyRef);
      if (existing.exists) {
        // A held capture blocks any other capture that day; never attach a decision here.
        requireCondition(!held);
        const daily = dailySchema.parse(existing.data());
        requireCondition(daily.pieceId === approval.normalizedPieceId);
        this.assertFresh(dayKey);
        return { pieceId: daily.pieceId, boardId: daily.boardId };
      }
      if (captureLease) {
        const capture = await readModel(
          this.db,
          tx,
          `captures/${captureLease.captureId}`,
          privateCaptureSchema,
        );
        requireCondition(
          capture.ownerUid === approval.ownerUid &&
            capture.pieceId === approval.normalizedPieceId &&
            capture.dayKey === dayKey &&
            capture.leaseToken === captureLease.token &&
            capture.status === 'processing',
        );
      }
      if (held) {
        const capture = await readModel(
          this.db,
          tx,
          `captures/${held.captureId}`,
          privateCaptureSchema,
        );
        requireCondition(
          capture.ownerUid === approval.ownerUid &&
            capture.pieceId === approval.normalizedPieceId &&
            capture.dayKey === dayKey &&
            capture.status === 'held',
        );
        this.assertFresh(dayKey, capture.expiresAtMs);
        await held.verify(tx);
      }
      const pieceId = approval.normalizedPieceId;
      const geometry = { ...generated, id: pieceId };
      const board: CanonicalBoard = {
        dayKey,
        version: 1,
        status: 'active',
        geometry: { pieces: [geometry], participantKeys: [participantKey] },
        members: [{ uid: approval.ownerUid, pieceId, participantKey }],
      };
      const privatePiece = {
        ownerUid: approval.ownerUid,
        dayKey,
        edges: geometry.edges,
        status: 'approved',
        username: approval.username,
        caption: approval.caption,
      } as const;
      this.assertFresh(dayKey);
      // No client can manufacture an approval. Phase 3 owns image verification and normalization.
      const captureId = captureLease?.captureId ?? held?.captureId;
      if (captureId)
        tx.update(this.db.doc(`captures/${captureId}`), {
          status: 'approved',
          boardId,
          leaseUntilMs: 0,
        });
      held?.record(tx);
      tx.create(this.db.doc(paths.piece(pieceId)), privatePiece);
      tx.create(this.db.doc(paths.board(boardId)), board);
      tx.create(dailyRef, { dayKey, boardId, pieceId, participantKey });
      const view = {
        boardId,
        dayKey,
        version: 1,
        pieces: [
          {
            ...geometry,
            visibility: 'visible',
            photoRef: `normalized/${pieceId}/image`,
            username: approval.username,
            caption: approval.caption,
          },
        ],
      };
      tx.create(this.db.doc(paths.view(approval.ownerUid, boardId)), view);
      tx.create(this.db.doc(paths.grant(approval.ownerUid, boardId)), {
        active: true,
        accessEpoch: subject.accessEpoch,
      });
      tx.create(this.db.doc(paths.media(pieceId)), {
        visible: true,
        epochs: { [approval.ownerUid]: subject.accessEpoch },
      });
      tx.set(this.db.doc(paths.clientState(approval.ownerUid)), {
        dayKey,
        boardId,
        accessRevision: subject.accessEpoch,
      });
      return { pieceId, boardId };
    });
  }

  async syncBoardView(uid: string, boardId: string): Promise<BoardView> {
    return this.db.runTransaction(async (tx) => {
      const subject = await readModel(
        this.db,
        tx,
        paths.subject(uid),
        subjectSchema,
      );
      requireCondition(subject.status === 'active', 'permission-denied');
      const board = await readModel(
        this.db,
        tx,
        paths.board(boardId),
        boardSchema,
      );
      requireCondition(
        board.status === 'active' &&
          board.members.some((member) => member.uid === uid),
        'permission-denied',
      );
      requireCondition(board.dayKey <= dayKeyAt(this.clock()));
      const state = await loadProjectionState(this.db, tx, board, [uid]);
      const view = writeProjections(this.db, tx, boardId, board, state, [
        uid,
      ])[0];
      requireCondition(view);
      return view;
    });
  }

  /**
   * Gallery discovery: boards of days that ended at 4:00 server time and that the caller can
   * still open. Retired (merged-away) boards lose their grant; the client then syncs each view.
   */
  async listGallery(uid: string): Promise<GalleryList> {
    const today = dayKeyAt(this.clock());
    const subject = await this.db.doc(paths.subject(uid)).get();
    requireCondition(
      subject.exists && subjectSchema.parse(subject.data()).status === 'active',
      'permission-denied',
    );
    const views = await this.db
      .collection(paths.views(uid))
      .where('dayKey', '<', today)
      .orderBy('dayKey', 'desc')
      .limit(400)
      .select('dayKey')
      .get();
    if (views.empty) return { entries: [] };
    const refs = views.docs.flatMap((view) => [
      this.db.doc(paths.board(view.id)),
      this.db.doc(paths.grant(uid, view.id)),
    ]);
    const snapshots = await this.db.getAll(...refs);
    const entries = views.docs.flatMap((view, index) => {
      const board = snapshots[index * 2];
      const grant = snapshots[index * 2 + 1];
      if (!board?.exists || grant?.get('active') !== true) return [];
      const parsed = boardSchema.parse(board.data());
      return parsed.status === 'active' &&
        parsed.dayKey < today &&
        parsed.members.some((member) => member.uid === uid)
        ? [{ boardId: view.id, dayKey: parsed.dayKey }]
        : [];
    });
    return galleryListSchema.parse({ entries });
  }

  /** Accepts only a private, server-verified two-party session; no client placement or seed. */
  async confirmFit(uid: string, sessionId: string): Promise<FitOutcome> {
    return this.db.runTransaction(
      async (tx) => {
        const now = this.clock();
        const dayKey = dayKeyAt(now);
        const sessionRef = this.db.doc(paths.session(sessionId));
        const session = await readModel(
          this.db,
          tx,
          sessionRef.path,
          sessionSchema,
        );
        requireCondition(
          session.participants.includes(uid),
          'permission-denied',
        );
        requireCondition(
          session.dayKey === dayKey &&
            session.expiresAtMs > now &&
            session.mutualDetectionVerified &&
            !session.cancelled,
        );
        const [firstUid, secondUid] = session.participants;
        for (const actor of session.participants) {
          const subject = await readModel(
            this.db,
            tx,
            paths.subject(actor),
            subjectSchema,
          );
          requireCondition(subject.status === 'active', 'permission-denied');
        }
        const firstDaily = await readModel(
          this.db,
          tx,
          paths.daily(dayKey, firstUid),
          dailySchema,
        );
        const secondDaily = await readModel(
          this.db,
          tx,
          paths.daily(dayKey, secondUid),
          dailySchema,
        );
        for (const [actor, daily] of [
          [firstUid, firstDaily],
          [secondUid, secondDaily],
        ] as const) {
          const piece = await readModel(
            this.db,
            tx,
            paths.piece(daily.pieceId),
            pieceSchema,
          );
          requireCondition(
            piece.ownerUid === actor &&
              piece.dayKey === dayKey &&
              piece.status === 'approved',
          );
        }
        // A consumed session is an ephemeral idempotency receipt, never a FIT history.
        if (session.outcome) {
          this.assertFresh(dayKey, session.expiresAtMs);
          return session.outcome;
        }
        const confirmed = [...new Set([...session.confirmed, uid])];
        if (confirmed.length < 2) {
          this.assertFresh(dayKey, session.expiresAtMs);
          tx.update(sessionRef, { confirmed });
          return { status: 'waiting' };
        }
        if (firstDaily.boardId === secondDaily.boardId) {
          this.assertFresh(dayKey, session.expiresAtMs);
          const outcome: FitOutcome = {
            status: 'not-merged',
            reason: 'already-connected',
          };
          tx.update(sessionRef, { confirmed, outcome });
          writeFitViews(
            this.db,
            tx,
            session.participants,
            sessionId,
            session.expiresAtMs,
            { stage: 'not-merged', reason: 'already-connected' },
          );
          return outcome;
        }
        const boardIds = [firstDaily.boardId, secondDaily.boardId].sort();
        const aId = boardIds[0];
        const bId = boardIds[1];
        requireCondition(aId && bId);
        const a = await readModel(this.db, tx, paths.board(aId), boardSchema);
        const b = await readModel(this.db, tx, paths.board(bId), boardSchema);
        requireCondition(
          a.status === 'active' &&
            b.status === 'active' &&
            a.dayKey === dayKey &&
            b.dayKey === dayKey,
        );
        for (const [actor, daily, board] of [
          [firstUid, firstDaily, firstDaily.boardId === aId ? a : b],
          [secondUid, secondDaily, secondDaily.boardId === aId ? a : b],
        ] as const) {
          requireCondition(
            board.members.some(
              (member) =>
                member.uid === actor &&
                member.pieceId === daily.pieceId &&
                member.participantKey === daily.participantKey,
            ),
          );
        }
        requireCondition(
          !a.members.some((member) =>
            b.members.some((other) => other.uid === member.uid),
          ),
        );
        const identity = mergeIdentity(sessionId, [
          { id: aId, version: a.version },
          { id: bId, version: b.version },
        ]);
        const result = mergeBoards(a.geometry, b.geometry, identity.seed);
        if (result.status !== 'merged') {
          this.assertFresh(dayKey, session.expiresAtMs);
          const outcome: FitOutcome = result;
          tx.update(sessionRef, { confirmed, outcome });
          writeFitViews(
            this.db,
            tx,
            session.participants,
            sessionId,
            session.expiresAtMs,
            {
              stage: 'not-merged',
              reason: result.reason,
              boardChanged: [a, b].some(
                (board, index) =>
                  session.boards !== undefined &&
                  session.boards[boardIds[index] ?? ''] !== board.version,
              ),
            },
          );
          return outcome;
        }
        const board: CanonicalBoard = boardSchema.parse({
          dayKey,
          version: Math.max(a.version, b.version) + 1,
          status: 'active',
          geometry: result.board,
          members: [...a.members, ...b.members],
        });
        const state = await loadProjectionState(this.db, tx, board);
        // D-09: the final server clock check is the logical confirmation time.
        // Retry callbacks check fresh time; Firestore commit completion may occur later.
        this.assertFresh(dayKey, session.expiresAtMs);
        const outcome: FitOutcome = {
          status: 'merged',
          boardId: identity.boardId,
        };
        tx.create(this.db.doc(paths.board(identity.boardId)), board);
        tx.update(this.db.doc(paths.board(aId)), { status: 'retired' });
        tx.update(this.db.doc(paths.board(bId)), { status: 'retired' });
        for (const member of board.members) {
          const subject = state.subjects.get(member.uid);
          requireCondition(subject);
          tx.update(this.db.doc(paths.daily(dayKey, member.uid)), {
            boardId: identity.boardId,
          });
          // Ended members keep their blank piece; their client documents are gone.
          if (subject.status === 'ended') continue;
          tx.set(this.db.doc(paths.clientState(member.uid)), {
            dayKey,
            boardId: identity.boardId,
            accessRevision: subject.accessEpoch,
          });
          tx.update(
            this.db.doc(
              paths.grant(
                member.uid,
                a.members.some((m) => m.uid === member.uid) ? aId : bId,
              ),
            ),
            { active: false },
          );
        }
        writeProjections(this.db, tx, identity.boardId, board, state);
        tx.update(sessionRef, { confirmed, outcome });
        writeFitViews(
          this.db,
          tx,
          session.participants,
          sessionId,
          session.expiresAtMs,
          { stage: 'merged', boardId: identity.boardId },
        );
        return outcome;
      },
      { maxAttempts: 10 },
    );
  }

  /** Phase 5 calls this after native mutual detection verification; no public issuance endpoint. */
  async createVerifiedSession(
    id: string,
    participants: [string, string],
    expiresAtMs: number,
  ): Promise<void> {
    const dayKey = dayKeyAt(this.clock());
    const session = sessionSchema.parse({
      dayKey,
      participants,
      mutualDetectionVerified: true,
      expiresAtMs,
      confirmed: [],
      outcome: null,
      expireAt: Timestamp.fromMillis(expiresAtMs),
    });
    requireCondition(
      expiresAtMs > this.clock() && dayKeyAt(expiresAtMs - 1) === dayKey,
    );
    await this.db.doc(paths.session(id)).create(session);
  }
}
