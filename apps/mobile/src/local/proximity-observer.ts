import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { ProximitySource } from '../fit/source';
import { FitTrialTimer, type WatchedFit } from './fit-trial-timer';
import {
  observedSource,
  ProximityDiagnostics,
  type InputKind,
} from './proximity-observation';

export const proximityDiagnostics = new ProximityDiagnostics();
export const fitTrialTimer = new FitTrialTimer(
  Date.now,
  // Stage, elapsed time and coarse method only, for the developer's Metro console in G-PROX trials.
  (line) => console.log(`[FIT試行] ${Platform.OS} ${line}`),
  () => {
    const { method } = proximityDiagnostics.snapshot();
    return method === 'ble' || method === 'uwb' ? method : 'unknown';
  },
);
export function diagnosticsEnabled(): boolean {
  const extra = Constants.expoConfig?.extra;
  if (!__DEV__ || extra?.mode !== 'local' || extra.variant !== 'development')
    return false;
  try {
    return (
      requireOptionalNativeModule<{ localBuildEnabled(): boolean }>(
        'Installation',
      )?.localBuildEnabled() === true
    );
  } catch {
    return false;
  }
}
export function observeProximity(
  source: ProximitySource | null,
  input: InputKind,
): ProximitySource | null {
  if (!diagnosticsEnabled()) return source;
  proximityDiagnostics.configure(input);
  return source ? observedSource(source, input, proximityDiagnostics) : null;
}
export function observeFit<T extends WatchedFit>(fit: T): T {
  if (diagnosticsEnabled()) fitTrialTimer.watch(fit);
  return fit;
}
