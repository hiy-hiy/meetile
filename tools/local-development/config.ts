import { z } from 'zod';

export const LOCAL_PROJECT = 'demo-puzzle-sns-local';
export const LOCAL_BUNDLE = 'jp.puzzlesns.app.local';
export const LOCAL_REGION = 'asia-northeast1';
export const LOCAL_TEST_VERSION = 'local-test-v1';
export const LOCAL_BUCKET = `${LOCAL_PROJECT}.appspot.com`;
// Server startup only. Never include a scenario in a client request.
export const localScenarioSchema = z.enum([
  'approved',
  'rejected',
  'held',
  'error-once',
]);
export const LOCAL_PORTS = {
  auth: 19099,
  firestore: 18080,
  storage: 19199,
  firestoreWebsocket: 19150,
  functions: 15001,
  hub: 14400,
  logging: 14500,
  eventarc: 19299,
  tasks: 19499,
} as const;

export function isLocalHost(host: string): boolean {
  const parts = host.split('.');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  )
    return false;
  const [a, b] = parts.map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  );
}

export const localDeviceSchema = z.strictObject({
  mode: z.literal('local'),
  projectId: z.literal(LOCAL_PROJECT),
  host: z
    .string()
    .refine(isLocalHost, 'A private IPv4 or loopback address is required'),
  iosServices: z.string().min(1),
  androidServices: z.string().min(1),
});
export type LocalDeviceSettings = z.infer<typeof localDeviceSchema>;

export function appMode(mode: unknown, variant: unknown): 'cloud' | 'local' {
  const selected = z.enum(['cloud', 'local']).default('cloud').parse(mode);
  if (selected === 'local' && variant !== 'development')
    throw new Error('Local mode requires development');
  return selected;
}

export const localHealthSchema = z.strictObject({
  mode: z.literal('local'),
  projectId: z.literal(LOCAL_PROJECT),
  protocol: z.literal(2),
  runId: z.uuid(),
  probe: z.uuid(),
});

export function assertLocalServer(
  environment: Record<string, string | undefined>,
): void {
  if (
    environment.FUNCTIONS_EMULATOR !== 'true' ||
    environment.GCLOUD_PROJECT !== LOCAL_PROJECT ||
    environment.PUZZLE_LOCAL_MODE !== 'session-v2'
  )
    throw new Error('Local connection API is emulator-only');
  z.uuid().parse(environment.PUZZLE_LOCAL_RUN_ID);
  for (const [name, port] of [
    ['FIREBASE_AUTH_EMULATOR_HOST', LOCAL_PORTS.auth],
    ['FIRESTORE_EMULATOR_HOST', LOCAL_PORTS.firestore],
    ['FIREBASE_STORAGE_EMULATOR_HOST', LOCAL_PORTS.storage],
  ] as const) {
    if (environment[name] !== `127.0.0.1:${port}`)
      throw new Error(`Local emulator required: ${name}`);
  }
}

// Stored only in the demo namespace; this is an internal-test acknowledgement.
export const localAcknowledgementSchema = z.strictObject({
  age16OrOlder: z.literal(true),
  accepted: z.literal(true),
  legalVersion: z.literal(LOCAL_TEST_VERSION),
});
