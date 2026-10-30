import type { Firestore } from 'firebase-admin/firestore';
import {
  assertLocalServer,
  localScenarioSchema,
} from '../../../../tools/local-development/config';
import {
  PhotoStorage,
  normalizePhoto,
  type PhotoBucket,
} from '../services/photo-storage';
import type { PhotoProcessor } from '../services/capture';
import { localTextRejected, type Decision } from '../domain/moderation';

// Synthetic fixture policy, not the product's moderation policy or a safety classifier.
const policy = {
  textHold: 0.5,
  textReject: 0.9,
  bannedWords: ['内部検証禁止語'],
};

export class LocalPhotoProcessor
  extends PhotoStorage
  implements PhotoProcessor
{
  private readonly scenario;
  constructor(
    bucket: PhotoBucket,
    private readonly db: Firestore,
  ) {
    assertLocalServer(process.env);
    super(bucket);
    this.scenario = localScenarioSchema.parse(
      process.env.PUZZLE_LOCAL_SCENARIO,
    );
  }
  async process(
    path: string,
    username: string,
    caption: string,
  ): Promise<{ decision: Decision; image: Buffer }> {
    assertLocalServer(process.env);
    const raw = await this.read(path);
    let image: Buffer;
    try {
      image = await normalizePhoto(raw);
    } catch {
      return { decision: 'rejected', image: Buffer.alloc(0) };
    }
    if ([username, caption].some((text) => localTextRejected(text, policy)))
      return { decision: 'rejected', image };
    if (this.scenario === 'error-once') {
      // Keep the first-failure marker across Functions workers and emulator restarts.
      // The capture lease already serializes processing of this upload.
      const marker = this.db.doc(`localPhotoAttempts/${path.split('/')[1]}`);
      const first = await this.db.runTransaction(async (tx) => {
        if ((await tx.get(marker)).exists) return false;
        tx.create(marker, { failedOnce: true });
        return true;
      });
      if (first) throw new Error('Synthetic transient failure');
    }
    return {
      decision: this.scenario === 'error-once' ? 'approved' : this.scenario,
      image,
    };
  }
}
