import { createHash, randomBytes } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type {
  BeginFitScanResult,
  FitPreview,
  ProximityResult,
} from '@puzzle-sns/contracts';
import { requireCondition } from '../domain/errors';
import {
  boardSchema,
  dailySchema,
  mediaAccessSchema,
  pieceSchema,
  proximityTokenSchema,
  rateLimitSchema,
  sessionSchema,
  subjectSchema,
  type ProximityToken,
} from '../domain/models';
import { dayKeyAt } from '../domain/time';
import { paths } from '../repositories/paths';
import { readModel } from '../repositories/documents';
import { writeFitViews } from './fit-views';

/** Development values until G-PROX fixes them from device measurements. */
export const FIT_LIMITS = {
  tokenTtlMs: 45_000,
  sessionTtlMs: 90_000,
  begin: { limit: 10, windowMs: 60_000 },
  report: { limit: 120, windowMs: 60_000 },
  preview: { limit: 30, windowMs: 60_000 },
  session: { limit: 60, windowMs: 24 * 60 * 60 * 1000 },
} as const;
type LimitKey = 'begin' | 'report' | 'preview' | 'session';
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_SHIFT_MS = 5 * 60 * 60 * 1000;

/** Never store or log the raw token; documents are keyed by its SHA-256. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Exclusive end of the current 4am-JST day. Tokens and sessions never outlive it. */
export function dayEndMs(serverTimeMs: number): number {
  return (
    (Math.floor((serverTimeMs + JST_SHIFT_MS) / DAY_MS) + 1) * DAY_MS -
    JST_SHIFT_MS
  );
}
export interface PreviewImages {
  read(path: string): Promise<Buffer>;
}

type Windows = Record<string, { startMs: number; count: number }>;
function bump(windows: Windows, key: LimitKey, now: number): Windows {
  const { limit, windowMs } = FIT_LIMITS[key];
  const current = windows[key];
  const fresh = !current || now - current.startMs >= windowMs;
  requireCondition(fresh || current.count < limit, 'resource-exhausted');
  return {
    ...windows,
    [key]: fresh
      ? { startMs: now, count: 1 }
      : { startMs: current.startMs, count: current.count + 1 },
  };
}

export class FitService {
  constructor(
    private readonly db: Firestore,
    private readonly images: PreviewImages,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Counts attempts even when the request later fails, so it runs in its own transaction. */
  private async consume(uid: string, key: LimitKey): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const now = this.clock();
      const ref = this.db.doc(paths.rateLimit(uid));
      const snapshot = await tx.get(ref);
      const windows = snapshot.exists
        ? rateLimitSchema.parse(snapshot.data()).windows
        : {};
      tx.set(ref, {
        windows: bump(windows, key, now),
        expireAt: Timestamp.fromMillis(now + DAY_MS + 60 * 60 * 1000),
      });
    });
  }

  async beginFitScan(uid: string): Promise<BeginFitScanResult> {
    await this.consume(uid, 'begin');
    const token = randomBytes(16).toString('base64url');
    return this.db.runTransaction(async (tx) => {
      const now = this.clock();
      const dayKey = dayKeyAt(now);
      const subject = await readModel(
        this.db,
        tx,
        paths.subject(uid),
        subjectSchema,
      );
      requireCondition(subject.status === 'active', 'permission-denied');
      const daily = await readModel(
        this.db,
        tx,
        paths.daily(dayKey, uid),
        dailySchema,
      );
      const piece = await readModel(
        this.db,
        tx,
        paths.piece(daily.pieceId),
        pieceSchema,
      );
      const board = await readModel(
        this.db,
        tx,
        paths.board(daily.boardId),
        boardSchema,
      );
      requireCondition(
        piece.ownerUid === uid &&
          piece.dayKey === dayKey &&
          piece.status === 'approved' &&
          board.status === 'active' &&
          board.members.length < 20,
      );
      const expiresAtMs = Math.min(now + FIT_LIMITS.tokenTtlMs, dayEndMs(now));
      const record: ProximityToken = {
        ownerUid: uid,
        dayKey,
        expiresAtMs,
        peer: null,
        sessionId: null,
        expireAt: Timestamp.fromMillis(expiresAtMs),
      };
      tx.create(this.db.doc(paths.proximityToken(hashToken(token))), record);
      return { token, expiresAtMs };
    });
  }

  /**
   * Distance is judged on the devices; the server only accepts a mutual claim between two
   * valid tokens. One-sided claims are stored but never match or block anyone.
   */
  async reportProximity(
    uid: string,
    token: string,
    peerToken: string,
  ): Promise<ProximityResult> {
    await this.consume(uid, 'report');
    const ownHash = hashToken(token);
    const peerHash = hashToken(peerToken);
    requireCondition(ownHash !== peerHash, 'invalid-argument');
    return this.db.runTransaction(
      async (tx) => {
        const now = this.clock();
        const dayKey = dayKeyAt(now);
        const ownRef = this.db.doc(paths.proximityToken(ownHash));
        const peerRef = this.db.doc(paths.proximityToken(peerHash));
        const [ownSnap, peerSnap] = await tx.getAll(ownRef, peerRef);
        requireCondition(ownSnap && peerSnap);
        requireCondition(ownSnap.exists);
        const own = proximityTokenSchema.parse(ownSnap.data());
        requireCondition(own.ownerUid === uid, 'permission-denied');
        if (own.dayKey !== dayKey || own.expiresAtMs <= now)
          return { status: 'expired' };
        if (!peerSnap.exists) return { status: 'expired' };
        const peer = proximityTokenSchema.parse(peerSnap.data());
        requireCondition(peer.ownerUid !== uid, 'invalid-argument');
        if (peer.dayKey !== dayKey || peer.expiresAtMs <= now)
          return { status: 'expired' };
        // Idempotent resend after a match; any other peer is an ambiguous third device.
        if (own.sessionId)
          return own.peer === peerHash
            ? { status: 'matched', sessionId: own.sessionId }
            : { status: 'conflict' };
        if (peer.sessionId || (own.peer && own.peer !== peerHash))
          return { status: 'conflict' };
        if (peer.peer !== ownHash) {
          tx.update(ownRef, { peer: peerHash });
          return { status: 'waiting' };
        }
        // Mutual detection: judge eligibility and boards on the server.
        const actors = [uid, peer.ownerUid] as const;
        const [subjects, dailies, limits] = await Promise.all([
          Promise.all(
            actors.map((actor) => tx.get(this.db.doc(paths.subject(actor)))),
          ),
          Promise.all(
            actors.map((actor) =>
              tx.get(this.db.doc(paths.daily(dayKey, actor))),
            ),
          ),
          Promise.all(
            actors.map((actor) => tx.get(this.db.doc(paths.rateLimit(actor)))),
          ),
        ]);
        const pieces = await Promise.all(
          dailies.map((daily) =>
            daily.exists
              ? tx.get(
                  this.db.doc(
                    paths.piece(dailySchema.parse(daily.data()).pieceId),
                  ),
                )
              : Promise.resolve(null),
          ),
        );
        const eligible = actors.every((actor, index) => {
          const subject = subjects[index];
          const piece = pieces[index];
          return (
            subject?.exists &&
            subjectSchema.parse(subject.data()).status === 'active' &&
            piece?.exists &&
            pieceSchema.safeParse(piece.data()).data?.status === 'approved' &&
            pieceSchema.parse(piece.data()).ownerUid === actor
          );
        });
        // A peer that cannot FIT looks the same as one that has not reported yet.
        if (!eligible) {
          tx.update(ownRef, { peer: peerHash });
          return { status: 'waiting' };
        }
        const [firstDaily, secondDaily] = dailies.map((snapshot) =>
          dailySchema.parse(snapshot.data()),
        );
        requireCondition(firstDaily && secondDaily);
        if (firstDaily.boardId === secondDaily.boardId)
          return { status: 'already-connected' };
        const [a, b] = await Promise.all(
          [firstDaily.boardId, secondDaily.boardId].map((id) =>
            readModel(this.db, tx, paths.board(id), boardSchema),
          ),
        );
        requireCondition(a && b);
        const nextWindows = limits.map((snapshot) =>
          bump(
            snapshot.exists
              ? rateLimitSchema.parse(snapshot.data()).windows
              : {},
            'session',
            now,
          ),
        );
        const sessionId = `s_${createHash('sha256')
          .update(JSON.stringify([ownHash, peerHash].sort()))
          .digest('hex')}`;
        const expiresAtMs = Math.min(
          now + FIT_LIMITS.sessionTtlMs,
          dayEndMs(now),
        );
        tx.create(
          this.db.doc(paths.session(sessionId)),
          sessionSchema.parse({
            dayKey,
            participants: [...actors],
            mutualDetectionVerified: true,
            expiresAtMs,
            confirmed: [],
            outcome: null,
            boards: {
              [firstDaily.boardId]: a.version,
              [secondDaily.boardId]: b.version,
            },
            expireAt: Timestamp.fromMillis(expiresAtMs),
          }),
        );
        tx.update(ownRef, { peer: peerHash, sessionId });
        tx.update(peerRef, { sessionId });
        actors.forEach((actor, index) =>
          tx.set(this.db.doc(paths.rateLimit(actor)), {
            windows: nextWindows[index],
            expireAt: Timestamp.fromMillis(now + DAY_MS + 60 * 60 * 1000),
          }),
        );
        writeFitViews(this.db, tx, actors, sessionId, expiresAtMs, {
          stage: 'matched',
        });
        return { status: 'matched', sessionId };
      },
      { maxAttempts: 10 },
    );
  }

  /** The counterpart's own piece only, re-checked against safety state on every read. */
  async getFitPreview(uid: string, sessionId: string): Promise<FitPreview> {
    await this.consume(uid, 'preview');
    const read = await this.db.runTransaction(async (tx) => {
      const now = this.clock();
      const dayKey = dayKeyAt(now);
      const session = await readModel(
        this.db,
        tx,
        paths.session(sessionId),
        sessionSchema,
      );
      requireCondition(session.participants.includes(uid), 'permission-denied');
      requireCondition(
        session.dayKey === dayKey &&
          session.expiresAtMs > now &&
          session.mutualDetectionVerified &&
          !session.cancelled &&
          !session.outcome,
      );
      const other = session.participants.find((actor) => actor !== uid);
      requireCondition(other);
      const [self, counterpart, daily, block] = await Promise.all([
        tx.get(this.db.doc(paths.subject(uid))),
        tx.get(this.db.doc(paths.subject(other))),
        tx.get(this.db.doc(paths.daily(dayKey, other))),
        tx.get(this.db.doc(paths.block(uid, other))),
      ]);
      requireCondition(
        self.exists && subjectSchema.parse(self.data()).status === 'active',
        'permission-denied',
      );
      const pieceId = dailySchema.parse(daily.data()).pieceId;
      const [piece, media, hidden] = await Promise.all([
        tx.get(this.db.doc(paths.piece(pieceId))),
        tx.get(this.db.doc(paths.media(pieceId))),
        tx.get(this.db.doc(paths.hidden(uid, pieceId))),
      ]);
      const record = pieceSchema.parse(piece.data());
      requireCondition(record.ownerUid === other);
      const visible =
        record.status === 'approved' &&
        counterpart.exists &&
        subjectSchema.parse(counterpart.data()).status === 'active' &&
        media.exists &&
        mediaAccessSchema.parse(media.data()).visible &&
        !block.exists &&
        !hidden.exists;
      return { pieceId, record, visible };
    });
    const { pieceId, record, visible } = read;
    const image = visible
      ? await this.images.read(`normalized/${pieceId}/image`)
      : null;
    return {
      sessionId,
      visibility: visible ? 'visible' : 'blank',
      edges: record.edges,
      username: visible ? record.username : null,
      caption: visible ? record.caption : null,
      imageBase64: image ? image.toString('base64') : null,
    };
  }

  async leaveFit(
    uid: string,
    sessionId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.db.runTransaction(async (tx) => {
      const sessionRef = this.db.doc(paths.session(sessionId));
      const session = await readModel(
        this.db,
        tx,
        sessionRef.path,
        sessionSchema,
      );
      requireCondition(session.participants.includes(uid), 'permission-denied');
      // A consumed session is final; leaving afterwards changes nothing.
      if (session.outcome) return { cancelled: false };
      tx.update(sessionRef, { cancelled: true });
      writeFitViews(
        this.db,
        tx,
        session.participants,
        sessionId,
        session.expiresAtMs,
        { stage: 'cancelled' },
      );
      return { cancelled: true };
    });
  }
}
