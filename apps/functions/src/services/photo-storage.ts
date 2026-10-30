import sharp from 'sharp';
import { PHOTO } from '@puzzle-sns/contracts';
import { requireCondition } from '../domain/errors';
// Storage I/O lives apart from sharp so the admin server can load it alone.
export { PhotoStorage, type PhotoBucket } from './photo-objects';

export async function normalizePhoto(raw: Buffer): Promise<Buffer> {
  requireCondition(raw.length > 0 && raw.length <= PHOTO.maxUploadBytes);
  const image = sharp(raw, {
    limitInputPixels: 25_000_000,
    failOn: 'warning',
    animated: false,
  });
  const meta = await image.metadata();
  requireCondition(meta.format === 'jpeg' && (meta.pages ?? 1) === 1);
  return image
    .rotate()
    .resize(PHOTO.pixels, PHOTO.pixels, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: PHOTO.quality })
    .toBuffer();
}
