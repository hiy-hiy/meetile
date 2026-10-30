import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { documentIdSchema } from '@puzzle-sns/contracts';
import { SafetyFoundation } from './safety';
import { pieceSchema, mediaAccessSchema } from '../domain/models';
import { paths } from '../repositories/paths';

const deletionJobSchema = z.strictObject({
  objectPath: z.string(),
  status: z.literal('pending'),
  attemptCount: z.number().int().nonnegative(),
  rawPaths: z
    .array(z.string().regex(/^pending\/[A-Za-z0-9_-]{1,128}\/image$/))
    .max(1)
    .optional(),
});
export class PhotoDeletionService {
  constructor(
    private readonly db: Firestore,
    private readonly photos: { remove(path: string): Promise<void> },
  ) {}
  async removeOwn(
    uid: string,
    pieceId: string,
  ): Promise<{ status: 'deleted' }> {
    await new SafetyFoundation(this.db).removeOwnPiece(uid, pieceId);
    await this.cleanOne(pieceId);
    return { status: 'deleted' };
  }
  async cleanup(): Promise<void> {
    const jobs = await this.db
      .collection('deletionJobs')
      .where('status', '==', 'pending')
      .limit(100)
      .get();
    await Promise.all(jobs.docs.map((job) => this.cleanOne(job.id)));
  }
  async cleanOne(pieceId: string): Promise<void> {
    const ref = this.db.doc(`deletionJobs/${documentIdSchema.parse(pieceId)}`);
    try {
      const snapshot = await ref.get();
      if (!snapshot.exists) return;
      const job = deletionJobSchema.parse(snapshot.data());
      if (job.objectPath !== `normalized/${pieceId}/image`)
        throw new Error('Invalid deletion target');
      const [piece, media] = await Promise.all([
        this.db.doc(paths.piece(pieceId)).get(),
        this.db.doc(paths.media(pieceId)).get(),
      ]);
      if (
        pieceSchema.parse(piece.data()).status === 'approved' ||
        mediaAccessSchema.parse(media.data()).visible
      )
        throw new Error('Photo is still visible');
      await Promise.all(
        [job.objectPath, ...(job.rawPaths ?? [])].map((path) =>
          this.photos.remove(path),
        ),
      );
      await ref.delete();
    } catch {
      // Never recreate a completed job if a concurrent worker already removed it.
      await this.db.runTransaction(async (tx) => {
        const latest = await tx.get(ref);
        if (!latest.exists) return;
        const attempts = latest.get('attemptCount') as unknown;
        if (typeof attempts === 'number' && Number.isSafeInteger(attempts + 1))
          tx.update(ref, { attemptCount: attempts + 1 });
      });
    }
  }
}
