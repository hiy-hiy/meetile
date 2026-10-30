import type { ProximitySource } from '../fit/source';

/** Production bundles have no development diagnostic store or UI. */
export function observeProximity(
  source: ProximitySource | null,
  _input: 'native' | 'simulated' | 'unavailable',
): ProximitySource | null {
  void _input;
  return source;
}
export function observeFit<T>(fit: T): T {
  return fit;
}
