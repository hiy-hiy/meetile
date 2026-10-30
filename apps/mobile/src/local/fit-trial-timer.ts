import type { FitStage } from '../fit/machine';

export type TrialMethod = 'ble' | 'uwb' | 'unknown';
export type TrialSnapshot =
  | { status: 'none'; number: number }
  | { status: 'running'; number: number; elapsedMs: number }
  | {
      status: 'preview';
      number: number;
      elapsedMs: number;
      method: TrialMethod;
    }
  | { status: 'ended'; number: number; elapsedMs: number; stage: FitStage };
export interface WatchedFit {
  snapshot(): { stage: FitStage };
  subscribe(listener: () => void): unknown;
}

const SEARCHING: FitStage[] = ['searching', 'multiple'];
const ON_THE_WAY: FitStage[] = [...SEARCHING, 'matched'];
const ended: Partial<Record<FitStage, string>> = {
  idle: '離脱',
  'already-connected': '接続不要',
  conflict: '競合',
  timeout: '時間切れ',
  'day-changed': '日付変更',
  unavailable: '利用不可',
  'rate-limited': '回数制限',
  'not-ready': '準備未完了',
};
export const endedLabel = (stage: FitStage) => ended[stage] ?? stage;
const seconds = (ms: number) => (ms / 1000).toFixed(1);
const methodLabel = { ble: 'BLE', uwb: 'UWB', unknown: '未確認' } as const;
export function formatTrial(state: TrialSnapshot): string {
  switch (state.status) {
    case 'none':
      return '試行タイマー：未計測';
    case 'running':
      return `試行#${state.number}：探索中 ${seconds(state.elapsedMs)}秒`;
    case 'preview':
      return `試行#${state.number}：相手のピース表示まで ${seconds(state.elapsedMs)}秒（一致時の方式：${methodLabel[state.method]}）`;
    case 'ended':
      return `試行#${state.number}：プレビューなしで終了（${endedLabel(state.stage)}・${seconds(state.elapsedMs)}秒）`;
  }
}

/**
 * G-PROX trials: time from entering FIT search to this device's counterpart preview.
 * Only the stage, elapsed time and coarse method are kept, in memory; never a peer, session
 * or token. The method is read when the server match arrives, before FIT stops the radio.
 */
export class FitTrialTimer {
  private state: TrialSnapshot = { status: 'none', number: 0 };
  private listeners = new Set<() => void>();
  private owner = 0;
  private startedAt = 0;
  private matchedMethod: TrialMethod = 'unknown';
  constructor(
    private readonly clock: () => number = Date.now,
    private readonly log: (line: string) => void = () => {},
    private readonly method: () => TrialMethod = () => 'unknown',
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(next: TrialSnapshot) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  /** Follows only the most recently created FIT controller. */
  watch(fit: WatchedFit) {
    const owner = ++this.owner;
    let previous = fit.snapshot().stage;
    fit.subscribe(() => {
      const stage = fit.snapshot().stage;
      if (owner !== this.owner || stage === previous) return;
      const before = previous;
      previous = stage;
      this.transition(before, stage);
    });
  }
  private transition(before: FitStage, stage: FitStage) {
    const now = this.clock();
    if (SEARCHING.includes(stage) && !SEARCHING.includes(before)) {
      this.startedAt = now;
      this.matchedMethod = 'unknown';
      this.set({
        status: 'running',
        number: this.state.number + 1,
        elapsedMs: 0,
      });
      return;
    }
    if (this.state.status !== 'running') return;
    if (stage === 'matched') this.matchedMethod = this.method();
    if (ON_THE_WAY.includes(stage)) return;
    const number = this.state.number;
    const elapsedMs = now - this.startedAt;
    const next: TrialSnapshot =
      stage === 'preview'
        ? { status: 'preview', number, elapsedMs, method: this.matchedMethod }
        : { status: 'ended', number, elapsedMs, stage };
    this.set(next);
    this.log(formatTrial(next));
  }
  refresh() {
    if (this.state.status !== 'running') return;
    const elapsedMs = Math.floor((this.clock() - this.startedAt) / 100) * 100;
    if (elapsedMs !== this.state.elapsedMs)
      this.set({ ...this.state, elapsedMs });
  }
}
