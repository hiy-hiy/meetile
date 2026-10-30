import type { Observation } from '../src/fit/policy';
import type { ProximitySource, UnavailableKind } from '../src/fit/source';
import {
  formatSummary,
  RssiSurvey,
  summarizeRssi,
  SURVEY_DURATION_MS,
  SURVEY_WARMUP_MS,
  surveyToken,
} from '../src/local/rssi-survey';

const at = (
  atMs: number,
  rssi: number,
  deviceId = 'private-peer',
  token: string | null = 'AAAAAAAAAAAAAAAAAAAAAA',
): Observation => ({ deviceId, token, rssi, distanceMeters: null, atMs });

test('window medians match the near judgement and windows with two peers stay out of the distribution', () => {
  const summary = summarizeRssi(
    [
      at(100, -50),
      at(400, -60),
      at(900, -40), // window 1 median −50
      at(1500, -55), // window 2: one sample
      at(2200, -30),
      at(2300, -70, 'other-peer'), // window 3: two peers
      // window 4: empty
      at(4100, -44, 'private-peer', null),
      at(4200, -46, 'private-peer', null), // window 5 median −45
      at(5100, -20), // after the survey
    ],
    0,
    5000,
  );
  expect(summary).toEqual({
    windows: 5,
    single: 3,
    multiple: 1,
    empty: 1,
    tokenRead: true,
    correctionDb: 0,
    min: -55,
    p10: -55,
    median: -50,
    p90: -45,
    max: -45,
  });
});

test('an unanswered survey reports no distribution instead of inventing values', () => {
  const summary = summarizeRssi([at(500, -40, 'x', null)], 1000, 3000);
  expect(summary).toMatchObject({
    windows: 3,
    single: 0,
    empty: 3,
    tokenRead: false,
    median: null,
  });
  expect(formatSummary(2, 'ios', summary)).toBe(
    '#2 ios 窓3 単独0 複数0 空3 tokenなし 補正- 最小- p10 - 中央- p90 - 最大-',
  );
});

test('the applied correction is reported beside raw values', () => {
  const values = [
    at(500, -60, 'private-peer', null),
    { ...at(700, -61), peerPlatform: 'android' as const },
  ];
  const summary = summarizeRssi(values, 0, 1000, (value) =>
    value.peerPlatform === 'android' ? 17 : 0,
  );
  expect(summary).toMatchObject({ correctionDb: 17, median: -60.5 });
  expect(formatSummary(3, 'ios', summary)).toContain('tokenあり 補正+17 最小');
});

test('nearest-rank percentiles use observed window medians', () => {
  const values = Array.from({ length: 20 }, (_, index) =>
    at(index * 1000 + 500, -60 + index),
  );
  expect(summarizeRssi(values, 0, 20_000)).toMatchObject({
    single: 20,
    p10: -59,
    median: -50.5,
    p90: -43,
  });
});

test('survey tokens use the 22-character form both native modules round-trip', () => {
  expect(surveyToken(new Uint8Array(16))).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  expect(surveyToken(new Uint8Array(16).fill(255))).toBe(
    '_____________________w',
  );
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index * 17);
  expect(surveyToken(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  expect(() => surveyToken(new Uint8Array(15))).toThrow();
});

describe('survey lifecycle', () => {
  beforeEach(() => jest.useFakeTimers({ now: 10_000 }));
  afterEach(() => jest.useRealTimers());
  function setup() {
    let observe: (value: Observation) => void = () => {};
    let fail: (kind: UnavailableKind) => void = () => {};
    const source: ProximitySource = {
      start: jest.fn(async (_token, seen, unavailable) => {
        observe = seen;
        fail = unavailable;
      }),
      stop: jest.fn(async () => true),
    };
    const report = jest.fn<void, [string]>();
    const survey = new RssiSurvey(
      source,
      () => new Uint8Array(16).fill(7),
      report,
      'android',
    );
    return {
      source,
      report,
      survey,
      emit: (value: Observation) => observe(value),
      fail: (kind: UnavailableKind) => fail(kind),
    };
  }

  test('warm-up is discarded, the radio stops, and only the aggregate is reported', async () => {
    const t = setup();
    await t.survey.start();
    expect(t.survey.snapshot()).toEqual({ status: 'running', number: 1 });
    expect(t.source.start).toHaveBeenCalledWith(
      surveyToken(new Uint8Array(16).fill(7)),
      expect.any(Function),
      expect.any(Function),
    );
    await t.survey.start(); // A second press while running is ignored.
    expect(t.source.start).toHaveBeenCalledTimes(1);
    t.emit(at(11_000, -20)); // Warm-up.
    for (let index = 0; index < 20; index += 1)
      t.emit(at(13_500 + index * 1000, -48));
    jest.advanceTimersByTime(SURVEY_WARMUP_MS + SURVEY_DURATION_MS);
    expect(t.source.stop).toHaveBeenCalledTimes(1);
    expect(t.survey.snapshot()).toMatchObject({
      status: 'done',
      summary: { single: 20, max: -48, empty: 0 },
    });
    expect(t.report).toHaveBeenCalledTimes(1);
    const line = t.report.mock.calls[0]?.[0] ?? '';
    expect(line).toContain('#1 android 窓20 単独20');
    expect(line).not.toContain('private-peer');
    expect(line).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
    t.emit(at(34_000, -10)); // Late native callbacks are ignored.
    expect(t.survey.snapshot()).toMatchObject({ summary: { max: -48 } });
  });

  test('unavailable radio ends the survey without a summary', async () => {
    const t = setup();
    await t.survey.start();
    t.fail('interrupted');
    expect(t.survey.snapshot()).toEqual({
      status: 'unavailable',
      number: 1,
      reason: 'interrupted',
    });
    expect(t.source.stop).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SURVEY_WARMUP_MS + SURVEY_DURATION_MS);
    expect(t.report).not.toHaveBeenCalled();
  });

  test('cancel stops the radio and a new survey gets a new number', async () => {
    const t = setup();
    await t.survey.start();
    t.survey.cancel();
    expect(t.survey.snapshot()).toEqual({ status: 'idle' });
    expect(t.source.stop).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(SURVEY_WARMUP_MS + SURVEY_DURATION_MS);
    expect(t.report).not.toHaveBeenCalled();
    await t.survey.start();
    expect(t.survey.snapshot()).toEqual({ status: 'running', number: 2 });
  });
});
