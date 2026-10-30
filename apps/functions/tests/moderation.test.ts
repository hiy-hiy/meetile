import sharp from 'sharp';
import {
  containsContact,
  decideModeration,
  localTextRejected,
  moderationPolicySchema,
} from '../src/domain/moderation';
import { normalizePhoto, moderatePhoto } from '../src/services/photo-processor';
const policy = {
  textHold: 0.5,
  textReject: 0.8,
  bannedWords: ['禁止語テスト'],
};
const safe = { adult: 'UNLIKELY', racy: 'VERY_UNLIKELY', violence: 'UNLIKELY' };
test.each(['adult', 'racy', 'violence'] as const)(
  'image threshold applies independently to %s',
  (field) => {
    expect(decideModeration({ ...safe, [field]: 'POSSIBLE' }, [], policy)).toBe(
      'held',
    );
    expect(decideModeration({ ...safe, [field]: 'LIKELY' }, [], policy)).toBe(
      'rejected',
    );
    expect(decideModeration({ ...safe, [field]: 'UNKNOWN' }, [], policy)).toBe(
      'held',
    );
    expect(
      decideModeration({ ...safe, [field]: 'unexpected' }, [], policy),
    ).toBe('held');
  },
);
test('text thresholds and unknown results fail closed', () => {
  expect(
    decideModeration(safe, [{ supported: true, scores: [0.49] }], policy),
  ).toBe('approved');
  expect(
    decideModeration(safe, [{ supported: true, scores: [0.5] }], policy),
  ).toBe('held');
  expect(
    decideModeration(safe, [{ supported: true, scores: [0.8] }], policy),
  ).toBe('rejected');
  for (const scores of [[], [NaN], [-0.1]])
    expect(decideModeration(safe, [{ supported: true, scores }], policy)).toBe(
      'held',
    );
  expect(
    decideModeration(safe, [{ supported: false, scores: [0] }], policy),
  ).toBe('held');
  expect(
    moderationPolicySchema.safeParse({ ...policy, textHold: 0.9 }).success,
  ).toBe(false);
});
test.each([
  '０９０－１２３４－５６７８',
  'h t t p s : / / example . com',
  '＠synthetic',
  'synthetic.xyz',
  'discord ID:synthetic',
  'LINE ID:synthetic',
  '禁止 語テスト',
])('rejects artificial contact and banned text: %s', (text) =>
  expect(localTextRejected(text, policy)).toBe(true),
);
test('allows ordinary synthetic captions', () =>
  expect(localTextRejected('青い四角と赤い丸', policy)).toBe(false));
test('re-encodes artificial JPEG to a square and strips EXIF/location metadata', async () => {
  const raw = await sharp({
    create: { width: 300, height: 150, channels: 3, background: '#d9624b' },
  })
    .withExif({
      IFD0: { Artist: 'synthetic fixture only' },
      IFD3: { GPSLatitudeRef: 'N' },
    })
    .jpeg()
    .toBuffer();
  expect((await sharp(raw).metadata()).exif).toBeDefined();
  const result = await normalizePhoto(raw);
  expect(await sharp(result).metadata()).toMatchObject({
    format: 'jpeg',
    width: 1024,
    height: 1024,
  });
  expect((await sharp(result).metadata()).exif).toBeUndefined();
});
test('rejects damaged, non-JPEG and excessive-size images', async () => {
  await expect(normalizePhoto(Buffer.from([0xff, 0xd8, 0]))).rejects.toThrow();
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  await expect(normalizePhoto(png)).rejects.toThrow();
  await expect(
    normalizePhoto(Buffer.alloc(5 * 1024 * 1024 + 1)),
  ).rejects.toThrow();
});

test('checks full image and normalized crop plus each non-empty text independently', async () => {
  const raw = await sharp({
    create: { width: 300, height: 150, channels: 3, background: 'white' },
  })
    .jpeg()
    .toBuffer();
  const image = jest.fn(async (content: Buffer) =>
    content.equals(raw) ? { ...safe, violence: 'LIKELY' } : safe,
  );
  const text = jest.fn(async () => ({ supported: true, scores: [0.1] }));
  expect(
    (await moderatePhoto(raw, '人工署名', '人工文章', policy, { image, text }))
      .decision,
  ).toBe('rejected');
  expect(image).toHaveBeenCalledTimes(2);
  expect(text).toHaveBeenCalledWith('人工署名');
  expect(text).toHaveBeenCalledWith('人工文章');
});
test('contact rejection skips cloud requests; unsupported text holds and service outage propagates', async () => {
  const raw = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'white' },
  })
    .jpeg()
    .toBuffer();
  const image = jest.fn(async () => safe);
  const text = jest.fn(async () => ({ supported: false, scores: [] }));
  expect(
    (
      await moderatePhoto(raw, '', 'https://example.com', policy, {
        image,
        text,
      })
    ).decision,
  ).toBe('rejected');
  expect(image).not.toHaveBeenCalled();
  expect(
    (await moderatePhoto(raw, '', '人工', policy, { image, text })).decision,
  ).toBe('held');
  image.mockImplementation(async () => {
    throw new Error('Artificial network outage');
  });
  await expect(
    moderatePhoto(raw, '', '', policy, { image, text }),
  ).rejects.toThrow();
});
test('the shared contact detector matches localTextRejected without banned words', () => {
  for (const value of [
    'ｔａｒｏ＠example.com',
    '090 1234 5678',
    'www.example.jp',
    'インスタ：sample',
  ]) {
    expect(containsContact(value)).toBe(true);
    expect(localTextRejected(value, policy)).toBe(true);
  }
  expect(containsContact('禁止語テスト')).toBe(false);
  expect(localTextRejected('禁止語テスト', policy)).toBe(true);
  expect(containsContact('端末を紛失したため写真の削除を希望')).toBe(false);
});
