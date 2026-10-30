import type { Observation } from '../fit/policy';
import type { ProximitySource, UnavailableKind } from '../fit/source';

/** Discarded while advertising, scanning and the GATT read settle. */
export const SURVEY_WARMUP_MS = 3000;
export const SURVEY_DURATION_MS = 20_000;
const WINDOW_MS = 1000;

export interface RssiSummary {
  windows: number;
  /** Windows with exactly one radio peer; only these enter the distribution. */
  single: number;
  multiple: number;
  empty: number;
  tokenRead: boolean;
  /** dB the near judgement adds to this peer's token-bearing samples; the values below are raw. */
  correctionDb: number | null;
  /** Over the single-peer window medians, as judge() computes them before correction. */
  min: number | null;
  p10: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
}
export type SurveyState =
  | { status: 'idle' }
  | { status: 'running'; number: number }
  | { status: 'done'; number: number; summary: RssiSummary }
  | { status: 'unavailable'; number: number; reason: UnavailableKind };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
/** Nearest-rank percentile, so every reported value is an observed window median. */
function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

/** Per-window medians per peer, as the near judgement sees them. No peer handles leave here. */
export function summarizeRssi(
  observations: readonly Observation[],
  fromMs: number,
  durationMs: number,
  correction: (value: Observation) => number = () => 0,
): RssiSummary {
  const windows = Math.floor(durationMs / WINDOW_MS);
  const medians: number[] = [];
  let multiple = 0;
  let empty = 0;
  for (let index = 0; index < windows; index += 1) {
    const from = fromMs + index * WINDOW_MS;
    const byPeer = new Map<string, number[]>();
    for (const value of observations)
      if (value.atMs > from && value.atMs <= from + WINDOW_MS)
        byPeer.set(value.deviceId, [
          ...(byPeer.get(value.deviceId) ?? []),
          value.rssi,
        ]);
    const peers = [...byPeer.values()];
    if (peers.length === 0) empty += 1;
    else if (peers.length > 1) multiple += 1;
    else medians.push(median(peers[0]!));
  }
  const sorted = [...medians].sort((a, b) => a - b);
  const pick = (fraction: number) =>
    sorted.length ? percentile(sorted, fraction) : null;
  const tokened = observations.filter(
    (value) =>
      value.token !== null &&
      value.atMs > fromMs &&
      value.atMs <= fromMs + durationMs,
  );
  return {
    windows,
    single: sorted.length,
    multiple,
    empty,
    tokenRead: tokened.length > 0,
    correctionDb: tokened.length ? Math.max(...tokened.map(correction)) : null,
    min: sorted[0] ?? null,
    p10: pick(0.1),
    median: sorted.length ? median(sorted) : null,
    p90: pick(0.9),
    max: sorted.at(-1) ?? null,
  };
}

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The 22-character base64url form of 16 bytes that both native modules accept. */
export function surveyToken(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('A survey token needs 16 bytes');
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  bits += '0000';
  let token = '';
  for (let index = 0; index < bits.length; index += 6)
    token += ALPHABET[parseInt(bits.slice(index, index + 6), 2)];
  return token;
}

export function formatSummary(
  number: number,
  platform: string,
  value: RssiSummary,
): string {
  const db = (v: number | null) => (v === null ? '-' : String(v));
  return (
    `#${number} ${platform} 窓${value.windows} 単独${value.single} 複数${value.multiple} 空${value.empty} ` +
    `token${value.tokenRead ? 'あり' : 'なし'} 補正${value.correctionDb === null ? '-' : `${value.correctionDb >= 0 ? '+' : ''}${value.correctionDb}`} ` +
    `最小${db(value.min)} p10 ${db(value.p10)} ` +
    `中央${db(value.median)} p90 ${db(value.p90)} 最大${db(value.max)}`
  );
}

/**
 * Local-development RSSI survey for G-PROX calibration. It advertises a random token that the
 * server never issued, makes no reports or judgements, and keeps observations only in memory until
 * the summary is computed. Only the aggregate leaves this class.
 */
export class RssiSurvey {
  private state: SurveyState = { status: 'idle' };
  private listeners = new Set<() => void>();
  private number = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observations: Observation[] = [];
  constructor(
    private readonly source: ProximitySource,
    private readonly randomBytes: () => Uint8Array,
    private readonly report: (line: string) => void,
    private readonly platform: string,
    private readonly clock: () => number = Date.now,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(state: SurveyState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async start(): Promise<void> {
    if (this.state.status === 'running') return;
    const number = ++this.number;
    this.observations = [];
    this.set({ status: 'running', number });
    const fromMs = this.clock() + SURVEY_WARMUP_MS;
    await this.source.start(
      surveyToken(this.randomBytes()),
      (value) => {
        if (this.running(number)) this.observations.push(value);
      },
      (reason) => {
        if (!this.running(number)) return;
        this.finish();
        this.set({ status: 'unavailable', number, reason });
      },
    );
    if (!this.running(number)) return;
    this.timer = setTimeout(() => {
      if (!this.running(number)) return;
      const summary = summarizeRssi(
        this.observations,
        fromMs,
        SURVEY_DURATION_MS,
        this.source.correction,
      );
      this.finish();
      this.report(formatSummary(number, this.platform, summary));
      this.set({ status: 'done', number, summary });
    }, SURVEY_WARMUP_MS + SURVEY_DURATION_MS);
  }
  // A method call, so TypeScript does not keep the pre-await narrowing of `state`.
  private running(number: number): boolean {
    return this.number === number && this.state.status === 'running';
  }
  private finish() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.observations = [];
    void this.source.stop();
  }
  cancel() {
    if (this.state.status !== 'running') return;
    this.finish();
    this.set({ status: 'idle' });
  }
}
