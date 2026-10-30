import { createHash } from 'node:crypto';
import type { getStorage } from 'firebase-admin/storage';
import { PHOTO } from '@puzzle-sns/contracts';
import { requireCondition } from '../domain/errors';
export type PhotoBucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

/** Shared image I/O only; external moderation stays in GooglePhotoProcessor. */
export class PhotoStorage {
  constructor(private readonly bucket: PhotoBucket) {}
  async read(path: string): Promise<Buffer> {
    const file = this.bucket.file(path);
    const [metadata] = await file.getMetadata();
    requireCondition(
      metadata.contentType === 'image/jpeg' &&
        Number(metadata.size) <= PHOTO.maxUploadBytes,
    );
    return (await file.download())[0];
  }
  async has(path: string): Promise<boolean> {
    return (await this.bucket.file(path).exists())[0];
  }
  async save(path: string, image: Buffer): Promise<void> {
    const file = this.bucket.file(path);
    const sha256 = createHash('sha256').update(image).digest('hex');
    // Also reject sequential replacement before saving. The live GCS generation precondition
    // protects the first-write race; Storage Emulator does not model that precondition.
    if ((await file.exists())[0]) {
      const [meta] = await file.getMetadata();
      requireCondition(
        meta.metadata?.sha256 === sha256 &&
          !meta.metadata?.firebaseStorageDownloadTokens,
      );
      return;
    }
    try {
      await file.save(image, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: 'image/jpeg',
          cacheControl: 'private, no-store',
          metadata: { sha256 },
        },
      });
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        Number(error.code) !== 412
      )
        throw error;
      const [meta] = await file.getMetadata();
      requireCondition(
        meta.metadata?.sha256 === sha256 &&
          !meta.metadata?.firebaseStorageDownloadTokens,
      );
    }
  }
  async remove(path: string): Promise<void> {
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }
}
