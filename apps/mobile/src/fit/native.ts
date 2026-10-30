import { z } from 'zod';
import { randomUUID } from 'expo-crypto';
import { receiveCorrection } from './calibration';
import type { Observation } from './policy';
import type { ProximitySource, UnavailableKind } from './source';

export const SERVICE_UUIDS = {
  development: 'BD1E1000-0E40-4CB6-AF31-8B034F29A718',
  staging: 'BD1E2000-0E40-4CB6-AF31-8B034F29A718',
  production: 'BD1E3000-0E40-4CB6-AF31-8B034F29A718',
  local: 'BD1E4000-0E40-4CB6-AF31-8B034F29A718',
} as const;
export interface NativeProximityModule {
  /** Local hardware model for the correction table; older binaries do not export it. */
  readonly model?: string;
  start(token: string, serviceUuid: string, runId: string): Promise<void>;
  stop(runId: string): Promise<void>;
  addListener(
    event: string,
    callback: (value: unknown) => void,
  ): { remove(): void };
}
const observationSchema = z.object({
  runId: z.string(),
  deviceId: z.string().min(1),
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22}$/)
    .nullable(),
  peerPlatform: z.enum(['ios', 'android']).nullish(),
  rssi: z.number().int().min(-127).max(-1),
  distanceMeters: z.number().nonnegative().finite().nullable(),
  atMs: z.number().nonnegative().finite(),
});
const unavailableSchema = z.object({
  runId: z.string(),
  kind: z.enum(['unsupported', 'permission', 'bluetooth-off', 'interrupted']),
});
/** Session handles and tokens live only in memory; observations never enter persistent logs. */
export class NativeProximity implements ProximitySource {
  private runId: string | null = null;
  private stopping: Promise<boolean> = Promise.resolve(true);
  private subscriptions: { remove(): void }[] = [];
  readonly correction: (value: Observation) => number;
  constructor(
    private readonly module: NativeProximityModule,
    private readonly serviceUuid: string,
    private readonly newRunId: () => string = randomUUID,
  ) {
    this.correction = receiveCorrection(module.model);
  }
  async start(
    token: string,
    observation: (value: Observation) => void,
    unavailable: (kind: UnavailableKind) => void,
  ): Promise<void> {
    void this.stop();
    const runId = this.newRunId();
    this.runId = runId;
    this.subscriptions = [
      this.module.addListener('observation', (value) => {
        const parsed = observationSchema.safeParse(value);
        if (
          !parsed.success ||
          this.runId !== runId ||
          parsed.data.runId !== runId
        )
          return;
        const { deviceId, token, peerPlatform, rssi, distanceMeters, atMs } =
          parsed.data;
        observation({
          deviceId,
          token,
          // Only alongside a readable token, as the native modules send it.
          ...(token && peerPlatform ? { peerPlatform } : {}),
          rssi,
          distanceMeters,
          atMs,
        });
      }),
      this.module.addListener('unavailable', (value) => {
        const parsed = unavailableSchema.safeParse(value);
        if (
          !parsed.success ||
          this.runId !== runId ||
          parsed.data.runId !== runId
        )
          return;
        void this.stop();
        unavailable(parsed.data.kind);
      }),
    ];
    try {
      await this.module.start(token, this.serviceUuid, runId);
    } catch {
      if (this.runId !== runId) return;
      void this.stop();
      unavailable('unsupported');
    }
  }
  stop(): Promise<boolean> {
    const id = this.runId;
    this.runId = null;
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
    if (!id) return this.stopping;
    this.stopping = this.module.stop(id).then(
      () => true,
      () => false,
    );
    return this.stopping;
  }
}
