import type { Observation } from './policy';
import type { ProximitySource, UnavailableKind } from './source';

export type SimulatedScenario = 'near' | 'far' | 'multiple';
/**
 * Development-only stand-in for the radio. It feeds the same observation shape as native code,
 * so screens and server wiring can be exercised without BLE. It proves nothing about distance.
 */
export class SimulatedProximity implements ProximitySource {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    /** Asks the local server to make an artificial counterpart claim the given token. */
    private readonly appear: (token: string) => Promise<string>,
    private readonly scenario: SimulatedScenario = 'near',
    private readonly clock: () => number = Date.now,
    private readonly intervalMs = 250,
  ) {}
  async start(
    token: string,
    onObservation: (value: Observation) => void,
    onUnavailable: (kind: UnavailableKind) => void,
  ): Promise<void> {
    this.stop();
    let peerToken: string;
    try {
      peerToken = await this.appear(token);
    } catch {
      onUnavailable('unsupported');
      return;
    }
    const rssi = this.scenario === 'far' ? -80 : -40;
    this.timer = setInterval(() => {
      const atMs = this.clock();
      onObservation({
        deviceId: 'simulated-1',
        token: peerToken,
        rssi,
        distanceMeters: null,
        atMs,
      });
      if (this.scenario === 'multiple')
        onObservation({
          deviceId: 'simulated-2',
          token: null,
          rssi: -50,
          distanceMeters: null,
          atMs,
        });
    }, this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
