import { observeProximity } from '@puzzle-sns/proximity-observer';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import {
  NativeProximity,
  SERVICE_UUIDS,
  type NativeProximityModule,
} from './native';
import Constants from 'expo-constants';
import { z } from 'zod';
import type { MobileController } from '../controller';
import { SimulatedProximity } from './simulated';
import { simulationAllowed, type ProximitySource } from './source';

const peerSchema = z.strictObject({ peerToken: z.string().min(1) });
/** Select the explicitly enabled development simulation, or the platform radio module. */
export function proximitySource(
  controller: MobileController,
): ProximitySource | null {
  const extra: unknown = Constants.expoConfig?.extra;
  const record = typeof extra === 'object' && extra !== null ? extra : {};
  const allowed = simulationAllowed({
    dev: __DEV__,
    variant:
      'variant' in record && typeof record.variant === 'string'
        ? record.variant
        : undefined,
    simulatedProximity:
      'simulatedProximity' in record && record.simulatedProximity === true,
  });
  if (!allowed) {
    if ('simulatedProximity' in record && record.simulatedProximity === true)
      return null;
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
    const environment =
      'mode' in record && record.mode === 'local'
        ? 'local'
        : 'variant' in record && typeof record.variant === 'string'
          ? record.variant
          : '';
    const uuid = SERVICE_UUIDS[environment as keyof typeof SERVICE_UUIDS];
    const module =
      requireOptionalNativeModule<NativeProximityModule>('Proximity');
    return observeProximity(
      module && uuid ? new NativeProximity(module, uuid) : null,
      module && uuid ? 'native' : 'unavailable',
    );
  }
  return observeProximity(
    new SimulatedProximity(
      async (token) =>
        peerSchema.parse(await controller.callPort('simulatePeer', { token }))
          .peerToken,
    ),
    'simulated',
  );
}
