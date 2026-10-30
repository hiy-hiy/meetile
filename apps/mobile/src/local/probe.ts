import { z } from 'zod';
import {
  localDeviceSchema,
  localHealthSchema,
  LOCAL_PROJECT,
  LOCAL_PORTS,
  LOCAL_REGION,
} from '../../../../tools/local-development/config';

export function probeAddress(
  settings: unknown,
  nativeEnabled: boolean,
  debug: boolean,
  nativeProject: string | undefined,
  probe: string,
): string {
  if (!nativeEnabled || !debug || nativeProject !== LOCAL_PROJECT)
    throw new Error('A local Debug binary and demo registration are required');
  const local = localDeviceSchema.parse(settings);
  z.uuid().parse(probe);
  return `http://${local.host}:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}/localHealth?probe=${probe}`;
}

export function verifyProbe(body: unknown, probe: string): void {
  const response = localHealthSchema.parse(body);
  if (response.probe !== probe) throw new Error('Unexpected probe response');
}
