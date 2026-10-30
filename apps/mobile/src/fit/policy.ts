/**
 * Proximity judgement from raw observations. Pure and clock-injected so boundary values are
 * unit-tested. All numbers are development defaults until G-PROX fixes them from measurements on
 * physical devices; passing here is not evidence of any real distance.
 */
export interface ProximityPolicy {
  /** Median RSSI (dBm, after device correction) at or above which a device counts as near. */
  nearRssi: number;
  /** Looser RSSI at which a device counts as present for the "other people close" check. */
  presenceRssi: number;
  /** Width of one median window. */
  windowMs: number;
  /** How long the near state must hold, in whole windows. */
  holdMs: number;
  /** UWB distance (m) at or under which a UWB-ranged device counts as near. */
  uwbNearMeters: number;
}
// nearRssi −48: G-PROX 5-5e from iPhone 16–Android 13 measurements (calibration.ts); not a 10 cm guarantee.
export const DEFAULT_POLICY: ProximityPolicy = {
  nearRssi: -48,
  presenceRssi: -70,
  windowMs: 1000,
  holdMs: 2000,
  uwbNearMeters: 0.15,
};
/** UI-only guide for the matched-session lifetime; the server enforces the real expiry. */
export const SESSION_UI_TIMEOUT_MS = 90_000;

export interface Observation {
  /** Ephemeral local handle for one radio peer. Never sent to the server. */
  deviceId: string;
  /** Peer's FIT token once read; null while still being exchanged. */
  token: string | null;
  /** Peer's OS class from the token value, for pair-specific RSSI correction only. */
  peerPlatform?: 'ios' | 'android' | null;
  rssi: number;
  /** UWB distance in metres when ranging is active for this peer. */
  distanceMeters: number | null;
  atMs: number;
}
export type Verdict =
  | { status: 'searching' }
  | { status: 'multiple' }
  | { status: 'near'; peerToken: string; method: 'ble' | 'uwb' };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (high === undefined) return Number.NaN;
  return sorted.length % 2 === 1 || low === undefined ? high : (low + high) / 2;
}
function windowSamples(
  samples: Observation[],
  from: number,
  to: number,
): Observation[] {
  return samples.filter((value) => value.atMs > from && value.atMs <= to);
}

const noCorrection = () => 0;
export function judge(
  observations: readonly Observation[],
  now: number,
  /** dB added to each sample (calibration.ts); presence and near both use the corrected value. */
  correction: (value: Observation) => number = noCorrection,
  policy: ProximityPolicy = DEFAULT_POLICY,
): Verdict {
  const windows = Math.ceil(policy.holdMs / policy.windowMs);
  const horizon = now - windows * policy.windowMs;
  const recent = observations.filter(
    (value) => value.atMs > horizon && value.atMs <= now,
  );
  const byDevice = new Map<string, Observation[]>();
  for (const value of recent)
    byDevice.set(value.deviceId, [
      ...(byDevice.get(value.deviceId) ?? []),
      value,
    ]);
  // Native callbacks may arrive out of timestamp order. Stable sort keeps arrival order for ties.
  for (const samples of byDevice.values())
    samples.sort((a, b) => a.atMs - b.atMs);
  // Presence uses only the latest window, so a device that left stops counting quickly.
  const present = [...byDevice.entries()].filter(([, samples]) => {
    const latest = windowSamples(samples, now - policy.windowMs, now);
    return (
      latest.length > 0 &&
      median(latest.map((value) => value.rssi + correction(value))) >=
        policy.presenceRssi
    );
  });
  if (present.length > 1) return { status: 'multiple' };
  const only = present[0];
  if (!only) return { status: 'searching' };
  const samples = only[1];
  // Seen for the whole hold time, not just in each window's last instant.
  const first = samples[0];
  if (!first || first.atMs > horizon + policy.windowMs / 2)
    return { status: 'searching' };
  let method: 'ble' | 'uwb' = 'ble';
  for (let index = 0; index < windows; index += 1) {
    const to = now - index * policy.windowMs;
    const bucket = windowSamples(samples, to - policy.windowMs, to);
    if (bucket.length === 0) return { status: 'searching' };
    const ranged = bucket.flatMap((value) =>
      value.distanceMeters === null ? [] : [value.distanceMeters],
    );
    // UWB is authoritative when it is ranging: a far UWB distance cannot be overruled by BLE.
    if (ranged.length > 0) {
      if (median(ranged) > policy.uwbNearMeters) return { status: 'searching' };
      method = 'uwb';
    } else if (
      median(bucket.map((value) => value.rssi + correction(value))) <
      policy.nearRssi
    )
      return { status: 'searching' };
  }
  // A failed reread or pending ranging must revoke the old readable token immediately.
  const token = samples.at(-1)?.token;
  return token
    ? { status: 'near', peerToken: token, method }
    : { status: 'searching' };
}
