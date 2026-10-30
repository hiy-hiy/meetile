import { z } from 'zod';
const settingsSchema = z.strictObject({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  iosServices: z.string().min(1),
  androidServices: z.string().min(1),
  icon: z.string().min(1).optional(),
  easProjectId: z.uuid().optional(),
  legal: z.strictObject({
    version: z.string().min(1).max(80),
    terms: z.url().startsWith('https://'),
    privacy: z.url().startsWith('https://'),
    community: z.url().startsWith('https://'),
  }),
  emulatorHost: z
    .string()
    .regex(/^[A-Za-z0-9.-]+$/)
    .optional(),
});
export const localSettingsSchema = z
  .partialRecord(z.enum(['development', 'staging']), settingsSchema)
  .superRefine((value, ctx) => {
    if (
      value.development &&
      value.staging &&
      value.development.projectId === value.staging.projectId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Firebase projects must be separate',
      });
    if (value.staging?.emulatorHost)
      ctx.addIssue({
        code: 'custom',
        message: 'Emulators are development-only',
      });
  });

const androidRegistrationSchema = z.object({
  project_info: z.object({ project_id: z.string() }),
  client: z.array(
    z.object({
      client_info: z.object({
        android_client_info: z.object({ package_name: z.string() }),
      }),
    }),
  ),
});
export function validateNativeRegistration(
  projectId: string,
  variant: 'development' | 'staging' | 'local',
  android: unknown,
  apple: string,
): void {
  const registration = androidRegistrationSchema.parse(android);
  const bundle = `jp.puzzlesns.app.${variant}`;
  if (
    registration.project_info.project_id !== projectId ||
    !registration.client.some(
      (client) =>
        client.client_info.android_client_info.package_name === bundle,
    )
  )
    throw new Error('Android project/package mismatch');
  for (const [key, expected] of [
    ['PROJECT_ID', projectId],
    ['BUNDLE_ID', bundle],
  ]) {
    const match = apple.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`),
    );
    if (match?.[1] !== expected)
      throw new Error('iOS project/package mismatch');
  }
}
