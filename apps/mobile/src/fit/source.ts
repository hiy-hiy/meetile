import type { Observation } from './policy';

export type UnavailableKind =
  'unsupported' | 'permission' | 'bluetooth-off' | 'interrupted';
/** Where radio observations come from: the native module (5-3/5-4) or a development stand-in. */
export interface ProximitySource {
  /** Advertise `token` and scan; `onObservation` reports raw peers, never judgements. */
  start(
    token: string,
    onObservation: (value: Observation) => void,
    onUnavailable: (kind: UnavailableKind) => void,
  ): Promise<void>;
  /** true acknowledges native teardown calls; it does not prove OS radio silence. */
  stop(): void | Promise<boolean>;
  /** Per-sample RSSI correction for this device's radio (calibration.ts); absent means none. */
  readonly correction?: (value: Observation) => number;
}

export interface SourceEnvironment {
  /** React Native's __DEV__: false in release builds. */
  dev: boolean;
  variant: string | undefined;
  /** Set only by the local-development app config. */
  simulatedProximity: boolean;
}
/** Simulated proximity exists only in development builds that opted in; never in staging/release. */
export function simulationAllowed(environment: SourceEnvironment): boolean {
  return (
    environment.dev &&
    environment.variant === 'development' &&
    environment.simulatedProximity
  );
}
