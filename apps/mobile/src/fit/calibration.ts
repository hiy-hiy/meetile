import type { Observation } from './policy';

export type PeerPlatform = 'ios' | 'android';
/**
 * G-PROX 5-5e: dB added to the RSSI that a local hardware model receives from a peer OS class, so
 * both sides of a measured pair meet DEFAULT_POLICY.nearRssi at a similar distance.
 *
 * Only measured pairs have an entry. An unmeasured pair (including iPhone–iPhone and every peer of
 * unknown class) gets 0, which makes FIT harder to start rather than letting it start from further
 * away. The two directions of one pair cannot tell receiver sensitivity from transmit power, so an
 * entry is valid only for the peer class it was measured against.
 */
const RECEIVE_CORRECTION_DB: Readonly<
  Record<string, Partial<Record<PeerPlatform, number>>>
> = {
  // iPhone 16 (iOS 26.5.2) receiving OPPO PDRM00 (Android 13, advertising HIGH), 2026-10-30:
  // side-by-side 10 cm and back-to-back 50 cm medians put the iPhone side about 17 dB below.
  'iPhone17,3': { android: 17 },
};

export function receiveCorrection(
  localModel: string | null | undefined,
): (value: Observation) => number {
  const row =
    localModel && Object.hasOwn(RECEIVE_CORRECTION_DB, localModel)
      ? RECEIVE_CORRECTION_DB[localModel]
      : undefined;
  return (value) =>
    (row && value.peerPlatform ? row[value.peerPlatform] : undefined) ?? 0;
}
