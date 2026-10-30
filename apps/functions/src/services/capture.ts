import { randomUUID } from 'node:crypto';
import { type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  captureStateSchema,
  submitCaptureSchema,
  uploadCaptureSchema,
  onboardingSchema,
  PHOTO,
  type CaptureState,
} from '@puzzle-sns/contracts';
import { privateCaptureSchema, type PrivateCapture } from '../domain/capture';
import { dayKeyAt } from '../domain/time';
import { requireCondition } from '../domain/errors';
import { subjectSchema } from '../domain/models';
import { paths } from '../repositories/paths';
import { readModel } from '../repositories/documents';
import { Backend } from './backend';
import type { Decision } from '../domain/moderation';

export interface PhotoProcessor {
  has(path: string): Promise<boolean>;
  process(
    path: string,
    username: string,
    caption: string,
  ): Promise<{ decision: Decision; image: Buffer }>;
  save(path: string, image: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
}
const capturePath = (id: string) => `captures/${id}`;
function publicState(id: string, state: PrivateCapture): CaptureState {
  return captureStateSchema.parse({
    captureId: id,
    dayKey: state.dayKey,
    status: state.status,
    uploadPath: state.uploadPath,
    boardId: state.boardId,
    username: state.username,
    caption: state.caption,
  });
}
export class CaptureService {
  constructor(
    private readonly db: Firestore,
    private readonly photos: PhotoProcessor,
    private readonly legalVersion: string,
    private readonly clock: () => number = Date.now,
  ) {}
  private async subject(tx: Transaction, uid: string) {
    const subject = await readModel(
      this.db,
      tx,
      paths.subject(uid),
      subjectSchema,
    );
    requireCondition(subject.status === 'active', 'permission-denied');
    const consent = await tx.get(this.db.doc(`consents/${uid}`));
    requireCondition(
      consent.get('legalVersion') === this.legalVersion &&
        consent.get('age16OrOlder') === true &&
        consent.get('accepted') === true,
      'permission-denied',
    );
    return subject;
  }
  async acceptOnboarding(uid: string, input: unknown): Promise<void> {
    const data = onboardingSchema.parse(input);
    requireCondition(data.legalVersion === this.legalVersion);
    await this.db.runTransaction(async (tx) => {
      const subject = await readModel(
        this.db,
        tx,
        paths.subject(uid),
        subjectSchema,
      );
      requireCondition(subject.status === 'active', 'permission-denied');
      tx.set(this.db.doc(`consents/${uid}`), {
        ...data,
        acceptedAtMs: this.clock(),
      });
    });
  }
  async begin(uid: string): Promise<CaptureState> {
    const id = randomUUID();
    const pieceId = randomUUID();
    return this.db.runTransaction(async (tx) => {
      const now = this.clock();
      const dayKey = dayKeyAt(now);
      await this.subject(tx, uid);
      const daily = await tx.get(this.db.doc(paths.daily(dayKey, uid)));
      requireCondition(!daily.exists);
      const pointerRef = this.db.doc(`captureOwners/${uid}/days/${dayKey}`);
      const pointer = await tx.get(pointerRef);
      if (pointer.exists) {
        const previousId: unknown = pointer.get('captureId');
        requireCondition(typeof previousId === 'string');
        const previous = await readModel(
          this.db,
          tx,
          capturePath(previousId),
          privateCaptureSchema,
        );
        if (previous.status !== 'rejected' && previous.status !== 'expired')
          return publicState(previousId, previous);
      }
      requireCondition(dayKeyAt(this.clock()) === dayKey);
      const expiresAtMs = Date.parse(`${dayKey}T19:00:00Z`);
      const state: PrivateCapture = {
        ownerUid: uid,
        pieceId,
        dayKey,
        status: 'open',
        uploadPath: `pending/${id}/image`,
        boardId: null,
        username: null,
        caption: null,
        leaseToken: null,
        leaseUntilMs: 0,
        expiresAtMs,
      };
      tx.create(this.db.doc(capturePath(id)), state);
      tx.set(pointerRef, { captureId: id });
      tx.create(this.db.doc(`captureCleanup/${id}`), {
        captureId: id,
        rawPath: state.uploadPath,
        pieceId,
        dueAtMs: expiresAtMs,
      });
      return publicState(id, state);
    });
  }
  async get(uid: string, id: string): Promise<CaptureState> {
    return this.db.runTransaction(async (tx) => {
      await this.subject(tx, uid);
      const state = await readModel(
        this.db,
        tx,
        capturePath(id),
        privateCaptureSchema,
      );
      requireCondition(state.ownerUid === uid, 'permission-denied');
      if (state.status !== 'approved') {
        const daily = await tx.get(this.db.doc(paths.daily(state.dayKey, uid)));
        if (daily.exists && daily.get('pieceId') === state.pieceId) {
          const boardId: unknown = daily.get('boardId');
          requireCondition(typeof boardId === 'string');
          tx.update(this.db.doc(capturePath(id)), {
            status: 'approved',
            boardId,
            leaseUntilMs: 0,
          });
          return publicState(id, { ...state, status: 'approved', boardId });
        }
      }
      if (state.status !== 'approved' && state.expiresAtMs <= this.clock()) {
        tx.update(this.db.doc(capturePath(id)), { status: 'expired' });
        return publicState(id, { ...state, status: 'expired' });
      }
      return publicState(id, state);
    });
  }
  /** Admin-only Storage writes avoid Firebase SDK upload download-token creation. */
  async upload(uid: string, input: unknown): Promise<CaptureState> {
    const data = uploadCaptureSchema.parse(input);
    const state = await this.get(uid, data.captureId);
    requireCondition(
      state.status === 'open' && state.dayKey === dayKeyAt(this.clock()),
    );
    const raw = Buffer.from(data.base64, 'base64');
    requireCondition(
      raw.length <= PHOTO.maxUploadBytes && raw[0] === 0xff && raw[1] === 0xd8,
    );
    await this.photos.save(state.uploadPath, raw);
    try {
      const latest = await this.get(uid, data.captureId);
      if (latest.status === 'expired')
        await this.cleanup(data.captureId, state.uploadPath);
      return latest;
    } catch (error) {
      await this.cleanup(data.captureId, state.uploadPath);
      throw error;
    }
  }
  async submit(uid: string, input: unknown): Promise<CaptureState> {
    const data = submitCaptureSchema.parse(input);
    const token = randomUUID();
    const current = await this.get(uid, data.captureId);
    if (
      current.status === 'open' &&
      !(await this.photos.has(current.uploadPath))
    )
      return current;
    const state = await this.db.runTransaction(async (tx) => {
      await this.subject(tx, uid);
      const state = await readModel(
        this.db,
        tx,
        capturePath(data.captureId),
        privateCaptureSchema,
      );
      requireCondition(state.ownerUid === uid, 'permission-denied');
      if (['approved', 'held', 'rejected', 'expired'].includes(state.status))
        return state;
      requireCondition(
        state.dayKey === dayKeyAt(this.clock()) &&
          state.expiresAtMs > this.clock(),
      );
      if (state.username !== null)
        requireCondition(
          state.username === data.username && state.caption === data.caption,
        );
      if (state.status === 'processing' && state.leaseUntilMs > this.clock())
        return state;
      const claimed: PrivateCapture = {
        ...state,
        status: 'processing',
        username: data.username,
        caption: data.caption,
        leaseToken: token,
        leaseUntilMs: this.clock() + 120000,
      };
      tx.update(this.db.doc(capturePath(data.captureId)), claimed);
      return claimed;
    });
    if (state.leaseToken !== token) return publicState(data.captureId, state);
    try {
      // Recover a crash after publication without re-moderating/deleting a published object.
      const existing = await this.db.doc(paths.daily(state.dayKey, uid)).get();
      if (existing.exists && existing.get('pieceId') === state.pieceId) {
        const boardId: unknown = existing.get('boardId');
        requireCondition(typeof boardId === 'string');
        await this.finish(data.captureId, token, 'approved', boardId);
        await this.cleanup(data.captureId, state.uploadPath);
        return this.get(uid, data.captureId);
      }
      const result = await this.photos.process(
        state.uploadPath,
        data.username,
        data.caption,
      );
      if (result.decision !== 'approved') {
        if (result.decision === 'held')
          await this.photos.save(
            `review/${data.captureId}/image`,
            result.image,
          );
        await this.finish(data.captureId, token, result.decision);
      } else {
        await this.photos.save(
          `normalized/${state.pieceId}/image`,
          result.image,
        );
        // The normalized object has no ACL until the server approval creates its piece.
        await this.db.runTransaction(async (tx) => {
          await this.subject(tx, uid);
          const latest = await readModel(
            this.db,
            tx,
            capturePath(data.captureId),
            privateCaptureSchema,
          );
          requireCondition(
            latest.leaseToken === token && latest.status === 'processing',
          );
          requireCondition(
            latest.dayKey === dayKeyAt(this.clock()) &&
              latest.expiresAtMs > this.clock(),
          );
          tx.set(this.db.doc(paths.approval(data.captureId)), {
            ownerUid: uid,
            dayKey: state.dayKey,
            status: 'approved',
            normalizedPieceId: state.pieceId,
            username: data.username,
            caption: data.caption,
          });
        });
        const published = await new Backend(
          this.db,
          this.clock,
        ).publishApprovedPiece(data.captureId, {
          captureId: data.captureId,
          token,
        });
        await this.finish(data.captureId, token, 'approved', published.boardId);
      }
      await this.cleanup(data.captureId, state.uploadPath);
    } catch {
      // Preserve raw input for a transient-error retry. Unknown failures never create an approval.
      const latest = await this.db.doc(capturePath(data.captureId)).get();
      if (
        latest.get('leaseToken') === token &&
        latest.get('status') === 'processing'
      ) {
        await this.finish(
          data.captureId,
          token,
          state.expiresAtMs <= this.clock() ? 'expired' : 'error',
        );
      }
    }
    // A slower, superseded processor may finish its Storage write after deletion.
    // Close that race without reopening publication; expiration cleanup is the
    // fallback if the processor is terminated before this check can run.
    const publishedPiece = await this.db.doc(paths.piece(state.pieceId)).get();
    if (publishedPiece.exists && publishedPiece.get('status') !== 'approved') {
      try {
        await this.photos.remove(`normalized/${state.pieceId}/image`);
      } catch {
        /* Cleanup job below retries. */
      }
    }
    // Recreate the job even if expiration cleanup ran while moderation/storage was in flight.
    await this.db.doc(`captureCleanup/${data.captureId}`).set(
      {
        captureId: data.captureId,
        rawPath: state.uploadPath,
        pieceId: state.pieceId,
        dueAtMs: state.expiresAtMs,
      },
      { merge: true },
    );
    return this.get(uid, data.captureId);
  }
  private async finish(
    id: string,
    token: string,
    status: PrivateCapture['status'],
    boardId: string | null = null,
  ) {
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.doc(capturePath(id));
      const state = await readModel(
        this.db,
        tx,
        ref.path,
        privateCaptureSchema,
      );
      requireCondition(state.leaseToken === token);
      const effectiveStatus =
        status !== 'approved' && state.expiresAtMs <= this.clock()
          ? 'expired'
          : status;
      tx.update(ref, { status: effectiveStatus, boardId, leaseUntilMs: 0 });
      if (effectiveStatus === 'held')
        tx.set(this.db.doc(`reviewQueue/${id}`), {
          captureId: id,
          ownerUid: state.ownerUid,
          dayKey: state.dayKey,
          status: 'pending',
          imagePath: `review/${id}/image`,
          username: state.username,
          caption: state.caption,
          heldAtMs: this.clock(),
        });
    });
  }
  private async cleanup(id: string, path: string) {
    try {
      await this.photos.remove(path);
    } catch {
      const state = privateCaptureSchema.parse(
        (await this.db.doc(capturePath(id)).get()).data(),
      );
      await this.db.doc(`captureCleanup/${id}`).set(
        {
          captureId: id,
          rawPath: path,
          pieceId: state.pieceId,
          dueAtMs: state.expiresAtMs,
          rawRemovalPending: true,
        },
        { merge: true },
      );
    }
  }
  /** Expired uploads and unreferenced normalized images; review evidence follows Phase 4 retention policy. */
  async cleanupExpired(): Promise<void> {
    const jobs = await this.db
      .collection('captureCleanup')
      .where('dueAtMs', '<=', this.clock())
      .limit(100)
      .get();
    for (const job of jobs.docs) {
      const id = job.id;
      try {
        const state = await this.db.runTransaction(async (tx) => {
          const state = await readModel(
            this.db,
            tx,
            capturePath(id),
            privateCaptureSchema,
          );
          requireCondition(state.expiresAtMs <= this.clock());
          const piece = await tx.get(this.db.doc(paths.piece(state.pieceId)));
          const review = await tx.get(this.db.doc(`reviewQueue/${id}`));
          if (state.status !== 'approved' && !piece.exists)
            tx.update(this.db.doc(capturePath(id)), { status: 'expired' });
          return {
            state,
            published: piece.exists && piece.get('status') === 'approved',
            // An approved held photo lives on as the normalized piece only; the
            // review copy must not outlive the owner's later deletion (§14).
            review: review.exists && review.get('decision') !== 'approve',
          };
        });
        await this.photos.remove(state.state.uploadPath);
        if (!state.published)
          await this.photos.remove(`normalized/${state.state.pieceId}/image`);
        if (!state.review) await this.photos.remove(`review/${id}/image`);
        await job.ref.delete();
      } catch {
        /* Keep the private cleanup job for the next scheduled attempt. */
      }
    }
  }
}
