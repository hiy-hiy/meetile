import { ImageAnnotatorClient } from '@google-cloud/vision';
import { v2 } from '@google-cloud/language';
import { requireCondition } from '../domain/errors';
import {
  decideModeration,
  localTextRejected,
  type ModerationPolicy,
  type Decision,
  type ImageSignals,
  type TextSignals,
} from '../domain/moderation';
import type { PhotoProcessor } from './capture';
import {
  normalizePhoto,
  PhotoStorage,
  type PhotoBucket,
} from './photo-storage';
export { normalizePhoto } from './photo-storage';

export interface ModerationGateway {
  image(content: Buffer): Promise<ImageSignals>;
  text(content: string): Promise<TextSignals>;
}
class GoogleGateway implements ModerationGateway {
  private readonly vision = new ImageAnnotatorClient();
  private readonly language = new v2.LanguageServiceClient();
  async image(content: Buffer): Promise<ImageSignals> {
    const [batch] = await this.vision.batchAnnotateImages(
      {
        requests: [
          { image: { content }, features: [{ type: 'SAFE_SEARCH_DETECTION' }] },
        ],
      },
      { timeout: 20000 },
    );
    const response = batch.responses?.[0];
    requireCondition(response && !response.error);
    const safe = response.safeSearchAnnotation;
    const value = (level: unknown): string =>
      typeof level === 'string'
        ? level
        : ([
            'UNKNOWN',
            'VERY_UNLIKELY',
            'UNLIKELY',
            'POSSIBLE',
            'LIKELY',
            'VERY_LIKELY',
          ][Number(level)] ?? 'UNKNOWN');
    return {
      adult: value(safe?.adult),
      racy: value(safe?.racy),
      violence: value(safe?.violence),
    };
  }
  async text(content: string): Promise<TextSignals> {
    const [response] = await this.language.moderateText(
      {
        document: { type: 'PLAIN_TEXT', content, languageCode: 'ja' },
        modelVersion: 'MODEL_VERSION_2',
      },
      { timeout: 20000 },
    );
    return {
      supported: response.languageSupported === true,
      scores: (response.moderationCategories ?? []).map(
        (category) => category.confidence ?? NaN,
      ),
    };
  }
}
export async function moderatePhoto(
  raw: Buffer,
  username: string,
  caption: string,
  policy: ModerationPolicy,
  gateway: ModerationGateway,
): Promise<{ decision: Decision; image: Buffer }> {
  let image: Buffer;
  try {
    image = await normalizePhoto(raw);
  } catch {
    return { decision: 'rejected', image: Buffer.alloc(0) };
  }
  if ([username, caption].some((text) => localTextRejected(text, policy)))
    return { decision: 'rejected', image };
  // Evaluate both full input and normalized crop. Empty optional text needs no text request.
  const [images, texts] = await Promise.all([
    Promise.all([raw, image].map((content) => gateway.image(content))),
    Promise.all(
      [username, caption]
        .filter((text) => text.length > 0)
        .map((content) => gateway.text(content)),
    ),
  ]);
  const decisions = images.map((signals) =>
    decideModeration(signals, texts, policy),
  );
  return {
    decision: decisions.includes('rejected')
      ? 'rejected'
      : decisions.includes('held')
        ? 'held'
        : 'approved',
    image,
  };
}
export class GooglePhotoProcessor
  extends PhotoStorage
  implements PhotoProcessor
{
  constructor(
    bucket: PhotoBucket,
    private readonly policy: ModerationPolicy,
  ) {
    super(bucket);
  }
  async process(
    path: string,
    username: string,
    caption: string,
  ): Promise<{ decision: Decision; image: Buffer }> {
    return moderatePhoto(
      await this.read(path),
      username,
      caption,
      this.policy,
      new GoogleGateway(),
    );
  }
}
