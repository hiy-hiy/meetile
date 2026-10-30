import { z } from 'zod';

export const webConfigSchema = z.strictObject({
  apiKey: z.string().min(1),
  authDomain: z.string().min(1),
  projectId: z.string().min(1),
  appId: z.string().min(1),
});
export type WebConfig = z.infer<typeof webConfigSchema>;
export interface AdminConfig {
  mode: 'local' | 'cloud';
  projectId: string;
  bucket: string;
  origin: string;
  runId: string | null;
  web: WebConfig | null;
}
export function readAdminConfig(
  env: Record<string, string | undefined> = process.env,
): AdminConfig {
  if (env.PUZZLE_ADMIN_MODE === 'local') {
    if (
      env.PUZZLE_ADMIN_PROJECT_ID !== 'demo-puzzle-sns-local' ||
      env.PUZZLE_ADMIN_BUCKET !== 'demo-puzzle-sns-local.appspot.com' ||
      env.GCLOUD_PROJECT !== 'demo-puzzle-sns-local' ||
      env.PUZZLE_ADMIN_ORIGIN !== 'http://127.0.0.1:3002' ||
      env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19099' ||
      env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:18080' ||
      env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:19199' ||
      env.STORAGE_EMULATOR_HOST !== 'http://127.0.0.1:19199'
    )
      throw new Error('Admin configuration unavailable');
    return {
      mode: 'local',
      projectId: 'demo-puzzle-sns-local',
      bucket: 'demo-puzzle-sns-local.appspot.com',
      origin: 'http://127.0.0.1:3002',
      runId: z.uuid().parse(env.PUZZLE_LOCAL_RUN_ID),
      web: null,
    };
  }
  if (env.PUZZLE_ADMIN_MODE !== 'cloud')
    throw new Error('Admin configuration unavailable');
  if (
    [
      'FIREBASE_AUTH_EMULATOR_HOST',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_STORAGE_EMULATOR_HOST',
      'STORAGE_EMULATOR_HOST',
    ].some((key) => env[key])
  )
    throw new Error('Admin configuration unavailable');
  const projectId = z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
    .parse(env.PUZZLE_ADMIN_PROJECT_ID);
  const origin = new URL(z.url().parse(env.PUZZLE_ADMIN_ORIGIN));
  const web = webConfigSchema.parse(
    JSON.parse(env.PUZZLE_ADMIN_FIREBASE_WEB ?? 'null') as unknown,
  );
  if (
    projectId.startsWith('demo-') ||
    env.GCLOUD_PROJECT !== projectId ||
    origin.protocol !== 'https:' ||
    origin.origin !== env.PUZZLE_ADMIN_ORIGIN ||
    origin.hostname === 'localhost' ||
    origin.username ||
    origin.password ||
    web.projectId !== projectId ||
    web.authDomain !== `${projectId}.firebaseapp.com`
  )
    throw new Error('Admin configuration unavailable');
  const bucket = z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .parse(env.PUZZLE_ADMIN_BUCKET);
  if (
    ![`${projectId}.appspot.com`, `${projectId}.firebasestorage.app`].includes(
      bucket,
    )
  )
    throw new Error('Admin configuration unavailable');
  return {
    mode: 'cloud',
    projectId,
    bucket,
    origin: origin.origin,
    web,
    runId: null,
  };
}
