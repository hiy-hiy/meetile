import {
  beginFitScanResultSchema,
  dayStateSchema,
  fitOutcomeSchema,
  fitPreviewSchema,
  fitViewSchema,
  leaveFitResultSchema,
  proximityResultSchema,
  type FitPreview,
} from '@puzzle-sns/contracts';
import type { MobilePort } from '../controller';
import {
  INITIAL,
  isActive,
  reduce,
  type FitEvent,
  type FitState,
} from './machine';
import {
  DEFAULT_POLICY,
  SESSION_UI_TIMEOUT_MS,
  judge,
  type Observation,
  type ProximityPolicy,
} from './policy';
import type { ProximitySource } from './source';

export interface FitSnapshot extends FitState {
  /** The counterpart's own piece only; kept in memory and dropped with the screen. */
  preview: FitPreview | null;
}
const code = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code.replace(/^functions\//, '')
    : '';
const TICK_MS = 500;
const REPORT_INTERVAL_MS = 1000;
const TOKEN_REFRESH_MS = 30_000; // Elapsed-time refresh only; expiry is always server-authoritative.

export class FitController {
  private state: FitSnapshot = { ...INITIAL, preview: null };
  private listeners = new Set<() => void>();
  private observations: Observation[] = [];
  private token: string | null = null;
  private pendingClaim: {
    token: string;
    peerToken: string;
    method: 'ble' | 'uwb';
  } | null = null;
  private lastReportMs = 0;
  private tokenIssuedAtMs = 0;
  private matchedAtMs = 0;
  private dayKey: string | null = null;
  private busyGeneration: number | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  constructor(
    private readonly port: MobilePort,
    private readonly source: ProximitySource | null,
    private readonly clock: () => number = Date.now,
    private readonly policy: ProximityPolicy = DEFAULT_POLICY,
  ) {}
  snapshot = (): FitSnapshot => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private apply(event: FitEvent, extra: Partial<FitSnapshot> = {}) {
    this.state = { ...this.state, ...reduce(this.state, event), ...extra };
    for (const listener of this.listeners) listener();
  }
  private stopRadio() {
    void this.source?.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.stopRadio();
    this.observations = [];
    this.token = null;
    this.lastReportMs = 0;
    this.state = { ...INITIAL, preview: null };
    this.apply({ type: 'start' });
    if (!this.source) {
      this.apply({ type: 'unavailable', kind: 'unsupported' });
      return;
    }
    try {
      this.dayKey = dayStateSchema.parse(
        await this.port.call('getDayState', {}),
      ).dayKey;
      if (generation !== this.generation) return;
      await this.issueToken(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.apply({
        type:
          code(error) === 'resource-exhausted' ? 'rate-limited' : 'not-ready',
      });
      this.stopRadio();
      return;
    }
    if (generation !== this.generation || !isActive(this.state.stage)) return;
    this.unsubscribe =
      this.port.subscribeFit?.(
        (value) => {
          const view = fitViewSchema.safeParse(value);
          if (!view.success || generation !== this.generation) return;
          this.apply({ type: 'progress', view: view.data });
          // Re-query our token-bound claim, rather than trusting an old owner progress snapshot.
          if (view.data.stage === 'matched' && this.pendingClaim)
            void this.tick(generation);
        },
        () => {},
      ) ?? null;
    this.timer = setInterval(() => void this.tick(generation), TICK_MS);
  }

  private async issueToken(generation: number): Promise<void> {
    const scan = beginFitScanResultSchema.parse(
      await this.port.call('beginFitScan', {}),
    );
    if (generation !== this.generation || !this.source) return;
    this.token = scan.token;
    this.tokenIssuedAtMs = this.clock();
    this.observations = [];
    this.pendingClaim = null;
    // Proactive rotation uses elapsed time; actual expiry is always server-authoritative.
    await this.source.start(
      scan.token,
      (value) => {
        if (generation !== this.generation || !isActive(this.state.stage))
          return;
        this.observations.push(value);
        // Keep only what the policy can use.
        const keep = value.atMs - 2 * this.policy.holdMs - this.policy.windowMs;
        this.observations = this.observations.filter((o) => o.atMs > keep);
      },
      (kind) => {
        if (generation !== this.generation) return;
        this.generation++;
        this.apply({ type: 'unavailable', kind });
        this.stopRadio();
      },
    );
  }

  private async tick(generation: number): Promise<void> {
    if (this.busyGeneration === generation || generation !== this.generation)
      return;
    const now = this.clock();
    const stage = this.state.stage;
    if (
      ['matched', 'preview', 'waiting'].includes(stage) &&
      now - this.matchedAtMs > SESSION_UI_TIMEOUT_MS
    ) {
      this.apply({ type: 'timeout' });
      this.stopRadio();
      return;
    }
    if (stage !== 'searching' && stage !== 'multiple') return;
    if (now - this.tokenIssuedAtMs >= TOKEN_REFRESH_MS) {
      this.busyGeneration = generation;
      try {
        await this.issueToken(generation);
      } catch (error) {
        if (generation === this.generation) {
          this.apply({
            type:
              code(error) === 'resource-exhausted'
                ? 'rate-limited'
                : 'not-ready',
          });
          this.stopRadio();
        }
      } finally {
        if (this.busyGeneration === generation) this.busyGeneration = null;
      }
      return;
    }
    const verdict = judge(
      this.observations,
      now,
      this.source?.correction,
      this.policy,
    );
    this.apply({ type: 'verdict', status: verdict.status });
    if (
      verdict.status === 'multiple' ||
      !this.token ||
      now - this.lastReportMs < REPORT_INTERVAL_MS
    )
      return;
    const claim =
      verdict.status === 'near'
        ? {
            token: this.token,
            peerToken: verdict.peerToken,
            method: verdict.method,
          }
        : this.pendingClaim;
    if (!claim) return;
    // After a near report, retry only that token-bound claim even if the matched peer stopped its
    // radio first. Never invent a new peer from old observations; multiple candidates still pause.
    this.pendingClaim = claim;
    this.lastReportMs = now;
    this.busyGeneration = generation;
    try {
      const result = proximityResultSchema.parse(
        await this.port.call('reportProximity', claim),
      );
      if (generation !== this.generation) {
        if (result.status === 'matched') {
          try {
            await this.port.call('leaveFit', { sessionId: result.sessionId });
          } catch {
            /* Server TTL remains authoritative. */
          }
        }
        return;
      }
      if (result.status === 'matched') {
        this.matchedAtMs = this.clock();
        this.apply({ type: 'matched', sessionId: result.sessionId });
        // Radio is not needed once matched; it also stops advertising the token.
        void this.source?.stop();
        const preview = fitPreviewSchema.parse(
          await this.port.call('getFitPreview', {
            sessionId: result.sessionId,
          }),
        );
        if (generation !== this.generation) return;
        this.apply({ type: 'preview-ready' }, { preview });
      } else if (result.status === 'already-connected') {
        this.apply({ type: 'already-connected' });
        this.stopRadio();
      } else if (result.status === 'conflict') {
        // The same token cannot be reused after an ambiguous claim; the user restarts apart.
        this.apply({ type: 'conflict' });
        this.stopRadio();
      } else if (result.status === 'expired') {
        await this.issueToken(generation);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (code(error) === 'resource-exhausted') {
        this.apply({ type: 'rate-limited' });
        this.stopRadio();
      } else if (isActive(this.state.stage) && this.state.sessionId) {
        await this.explainEnd();
      }
    } finally {
      if (this.busyGeneration === generation) this.busyGeneration = null;
    }
  }

  /** Confirms the counterpart shown in the preview; the server judges on the latest board. */
  async confirm(): Promise<void> {
    const { stage, sessionId } = this.state;
    if (stage !== 'preview' || !sessionId) return;
    const generation = this.generation;
    try {
      const outcome = fitOutcomeSchema.parse(
        await this.port.call('confirmFit', { sessionId }),
      );
      if (generation !== this.generation) return;
      this.apply({ type: 'confirmed' });
      // The final result also arrives through the owner-only progress document.
      if (outcome.status === 'merged')
        this.apply({
          type: 'progress',
          view: fitViewSchema.parse({
            sessionId,
            stage: 'merged',
            reason: null,
            boardId: outcome.boardId,
            boardChanged: false,
          }),
        });
    } catch {
      if (generation === this.generation) await this.explainEnd();
    }
  }

  /** After a failure, the server's day state tells a date change from a plain expiry. */
  private async explainEnd(): Promise<void> {
    try {
      const day = dayStateSchema.parse(await this.port.call('getDayState', {}));
      this.apply({
        type: day.dayKey === this.dayKey ? 'timeout' : 'day-changed',
      });
    } catch {
      this.apply({ type: 'timeout' });
    }
    this.stopRadio();
  }

  /** Leaving, backgrounding or closing ends an unconfirmed session; a consumed one is unchanged. */
  async leave(): Promise<void> {
    const { stage, sessionId } = this.state;
    this.generation++;
    this.stopRadio();
    this.apply({ type: 'leave' }, { preview: null });
    if (sessionId && ['matched', 'preview', 'waiting'].includes(stage)) {
      try {
        leaveFitResultSchema.parse(
          await this.port.call('leaveFit', { sessionId }),
        );
      } catch {
        /* The session still expires on the server. */
      }
    }
  }

  /** Server date check on return to the foreground (spec §10). */
  async recheckDay(): Promise<void> {
    if (!isActive(this.state.stage) || this.dayKey === null) return;
    try {
      const day = dayStateSchema.parse(await this.port.call('getDayState', {}));
      if (day.dayKey !== this.dayKey) {
        this.apply({ type: 'day-changed' });
        this.stopRadio();
      }
    } catch {
      /* Offline: the next server call decides. */
    }
  }
}
