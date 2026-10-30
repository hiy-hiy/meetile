import { FitTrialTimer, formatTrial } from '../src/local/fit-trial-timer';
import type { FitStage } from '../src/fit/machine';

function fakeFit() {
  let stage: FitStage = 'idle';
  const listeners = new Set<() => void>();
  return {
    snapshot: () => ({ stage, sessionId: 'private-session', peer: 'private' }),
    subscribe: (listener: () => void) => listeners.add(listener),
    go(next: FitStage) {
      stage = next;
      for (const listener of listeners) listener();
    },
  };
}
function setup() {
  let now = 10_000;
  const log = jest.fn();
  let method: 'ble' | 'uwb' | 'unknown' = 'ble';
  const timer = new FitTrialTimer(
    () => now,
    log,
    () => method,
  );
  const fit = fakeFit();
  timer.watch(fit);
  return {
    timer,
    fit,
    log,
    at: (value: number) => {
      now = value;
    },
    radio: (value: typeof method) => {
      method = value;
    },
  };
}

test('times entering search to this device preview, across multiple and matched stages', () => {
  const t = setup();
  expect(formatTrial(t.timer.snapshot())).toBe('試行タイマー：未計測');
  t.fit.go('searching');
  t.at(12_000);
  t.fit.go('multiple');
  t.fit.go('searching');
  t.at(13_900);
  t.fit.go('matched');
  // FIT stops the radio after the match; the method seen at the match is kept.
  t.radio('unknown');
  t.at(14_234);
  t.fit.go('preview');
  expect(t.timer.snapshot()).toEqual({
    status: 'preview',
    number: 1,
    elapsedMs: 4234,
    method: 'ble',
  });
  expect(t.log).toHaveBeenCalledTimes(1);
  expect(t.log).toHaveBeenCalledWith(
    '試行#1：相手のピース表示まで 4.2秒（一致時の方式：BLE）',
  );
  // Leaving after the preview keeps the recorded time.
  t.at(20_000);
  t.fit.go('idle');
  expect(formatTrial(t.timer.snapshot())).toBe(
    '試行#1：相手のピース表示まで 4.2秒（一致時の方式：BLE）',
  );
  expect(JSON.stringify(t.timer.snapshot())).not.toContain('private');
});

test('running time is shown in 0.1 s steps and an attempt without a preview records how it ended', () => {
  const t = setup();
  t.fit.go('searching');
  t.at(17_480);
  t.timer.refresh();
  expect(formatTrial(t.timer.snapshot())).toBe('試行#1：探索中 7.4秒');
  t.at(20_300);
  t.fit.go('idle');
  expect(t.timer.snapshot()).toEqual({
    status: 'ended',
    number: 1,
    elapsedMs: 10_300,
    stage: 'idle',
  });
  expect(t.log).toHaveBeenCalledWith(
    '試行#1：プレビューなしで終了（離脱・10.3秒）',
  );
  t.at(30_000);
  t.timer.refresh();
  expect(t.timer.snapshot().status).toBe('ended');
});

test('retrying from a terminal stage starts the next numbered attempt', () => {
  const t = setup();
  t.fit.go('searching');
  t.at(11_000);
  t.fit.go('already-connected');
  expect(formatTrial(t.timer.snapshot())).toBe(
    '試行#1：プレビューなしで終了（接続不要・1.0秒）',
  );
  t.fit.go('searching');
  expect(t.timer.snapshot()).toEqual({
    status: 'running',
    number: 2,
    elapsedMs: 0,
  });
});

test('a stale or missing observation at the match is recorded as an unconfirmed method', () => {
  const t = setup();
  t.radio('unknown');
  t.fit.go('searching');
  t.fit.go('matched');
  t.radio('uwb');
  t.fit.go('preview');
  expect(formatTrial(t.timer.snapshot())).toMatch(/一致時の方式：未確認）$/);
});

test('only the most recently created FIT controller is followed', () => {
  const t = setup();
  t.fit.go('searching');
  const newer = fakeFit();
  t.timer.watch(newer);
  t.at(12_000);
  t.fit.go('preview');
  expect(t.timer.snapshot().status).toBe('running');
  newer.go('searching');
  t.at(15_000);
  newer.go('preview');
  expect(t.timer.snapshot()).toMatchObject({
    status: 'preview',
    number: 2,
    elapsedMs: 3000,
  });
});
