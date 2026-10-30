import {
  captionSchema,
  signatureSchema,
  textLength,
  submitCaptureSchema,
  onboardingSchema,
  uploadCaptureSchema,
  captureStateSchema,
  PHOTO,
} from '../src';
test('counts user-perceived Unicode characters consistently on server and mobile', () => {
  expect(textLength('か\u3099')).toBe(1);
  expect(textLength('👨‍👩‍👧‍👦')).toBe(1);
  expect(signatureSchema.parse('  か\u3099  ')).toBe('が');
  expect(signatureSchema.parse('')).toBe('');
  expect(signatureSchema.safeParse('🐈'.repeat(20)).success).toBe(true);
  expect(signatureSchema.safeParse('🐈'.repeat(21)).success).toBe(false);
  expect(captionSchema.safeParse('あ'.repeat(140)).success).toBe(true);
  expect(captionSchema.safeParse('あ'.repeat(141)).success).toBe(false);
  expect(signatureSchema.safeParse('\u0000').success).toBe(false);
});
test('validates camera-sized base64 without regexp stack overflow and still rejects padding/size errors', () => {
  const valid = Buffer.alloc(PHOTO.maxUploadBytes).toString('base64');
  expect(
    uploadCaptureSchema.parse({ captureId: 'synthetic', base64: valid }).base64,
  ).toBe(valid);
  for (const invalid of [
    'AAA',
    'A===',
    'AA=A',
    'AAAA=',
    '====',
    'AAA\n',
    valid + 'AAAA',
  ])
    expect(
      uploadCaptureSchema.safeParse({ captureId: 'synthetic', base64: invalid })
        .success,
    ).toBe(false);
  for (const validPadding of ['AAAA', 'AAA=', 'AA=='])
    expect(
      uploadCaptureSchema.safeParse({
        captureId: 'synthetic',
        base64: validPadding,
      }).success,
    ).toBe(true);
});
test('capture boundaries reject forged shapes, consent, metadata and unsafe input', () => {
  expect(
    submitCaptureSchema.safeParse({
      captureId: 'c',
      username: '',
      caption: '',
      edges: {},
    }).success,
  ).toBe(false);
  expect(
    onboardingSchema.safeParse({
      age16OrOlder: false,
      accepted: true,
      legalVersion: 'v1',
    }).success,
  ).toBe(false);
  expect(
    onboardingSchema.safeParse({
      age16OrOlder: true,
      accepted: false,
      legalVersion: 'v1',
    }).success,
  ).toBe(false);
  expect(
    uploadCaptureSchema.safeParse({ captureId: 'c', base64: '////' }).success,
  ).toBe(true);
  expect(
    uploadCaptureSchema.safeParse({ captureId: 'c', base64: '../??' }).success,
  ).toBe(false);
  expect(
    captureStateSchema.safeParse({
      captureId: 'c',
      dayKey: '2026-10-10',
      status: 'open',
      uploadPath: 'pending/c/image',
      boardId: null,
      username: null,
      caption: null,
      safetyId: 'secret',
    }).success,
  ).toBe(false);
});
