import type { Observation } from '../fit/policy';
import type { ProximitySource, UnavailableKind } from '../fit/source';

export type InputKind = 'native' | 'simulated' | 'unavailable';
export interface DiagnosticSnapshot {
  input: InputKind;
  activity:
    | 'idle'
    | 'starting'
    | 'observing'
    | 'stopping'
    | 'stopped'
    | 'unconfirmed'
    | 'unavailable';
  method: 'none' | 'pending' | 'ble' | 'uwb' | 'stale';
  reason: UnavailableKind | null;
}
/** One in-memory coarse snapshot. No peer, token, raw measurement, history or persistence. */
export class ProximityDiagnostics {
  private state: DiagnosticSnapshot = {
    input: 'unavailable',
    activity: 'idle',
    method: 'none',
    reason: null,
  };
  private listeners = new Set<() => void>();
  private owner = 0;
  private observedAt: number | null = null;
  constructor(private readonly clock: () => number = Date.now) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<DiagnosticSnapshot>, deferred = false) {
    const next = { ...this.state, ...value };
    if (
      Object.keys(next).every(
        (key) =>
          next[key as keyof DiagnosticSnapshot] ===
          this.state[key as keyof DiagnosticSnapshot],
      )
    )
      return;
    this.state = next;
    const notify = () => {
      for (const listener of this.listeners) listener();
    };
    if (deferred) queueMicrotask(notify);
    else notify();
  }
  /** Called while the FIT screen renders, so the panel is notified after that render. */
  configure(input: InputKind) {
    if (
      ['idle', 'stopped', 'unconfirmed', 'unavailable'].includes(
        this.state.activity,
      )
    )
      this.update({ input }, true);
  }
  begin(input: InputKind) {
    this.owner++;
    this.observedAt = null;
    this.update({ input, activity: 'starting', method: 'none', reason: null });
    return this.owner;
  }
  observe(owner: number, value: Observation) {
    if (
      owner !== this.owner ||
      !['starting', 'observing'].includes(this.state.activity)
    )
      return;
    if (this.clock() - value.atMs < 0 || this.clock() - value.atMs > 1000)
      return;
    if (this.observedAt !== null && value.atMs < this.observedAt) return;
    this.observedAt = value.atMs;
    this.update({
      activity: 'observing',
      method:
        value.distanceMeters !== null
          ? 'uwb'
          : value.token !== null
            ? 'ble'
            : 'pending',
    });
  }
  refresh() {
    if (
      this.observedAt !== null &&
      this.clock() - this.observedAt > 1000 &&
      this.state.activity === 'observing'
    )
      this.update({ method: 'stale' });
  }
  stopping(owner: number) {
    if (owner !== this.owner) return;
    this.observedAt = null;
    this.update({ activity: 'stopping', method: 'none' });
  }
  stopped(
    owner: number,
    confirmed: boolean,
    reason: UnavailableKind | null = null,
  ) {
    if (owner !== this.owner) return;
    this.observedAt = null;
    this.update({
      activity: reason ? 'unavailable' : confirmed ? 'stopped' : 'unconfirmed',
      method: 'none',
      reason,
    });
  }
}

export function observedSource(
  source: ProximitySource,
  input: InputKind,
  store: ProximityDiagnostics,
): ProximitySource {
  let owner: number | null = null;
  let active = false;
  let failure: UnavailableKind | null = null;
  store.configure(input);
  return {
    ...(source.correction ? { correction: source.correction } : {}),
    async start(token, observation, unavailable) {
      active = true;
      failure = null;
      const current = store.begin(input);
      owner = current;
      await source.start(
        token,
        (value) => {
          if (!active || owner !== current) return;
          store.observe(current, value);
          observation(value);
        },
        (kind) => {
          if (!active || owner !== current) return;
          active = false;
          failure = kind;
          store.stopped(current, false, kind);
          unavailable(kind);
        },
      );
    },
    stop() {
      active = false;
      const current = owner;
      const reason = failure;
      if (current !== null) store.stopping(current);
      try {
        const result = source.stop();
        return Promise.resolve(result).then(
          (confirmed) => {
            const done = input === 'simulated' || confirmed === true;
            if (current !== null) store.stopped(current, done, reason);
            return done;
          },
          () => {
            if (current !== null) store.stopped(current, false, reason);
            return false;
          },
        );
      } catch {
        if (current !== null) store.stopped(current, false, reason);
        return Promise.resolve(false);
      }
    },
  };
}
