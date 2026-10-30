import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  localSettingsSchema,
  validateNativeRegistration,
} from '../apps/mobile/src/build-settings.ts';
const issues = [];
const root = resolve('apps/mobile');
try {
  const config = localSettingsSchema.parse(
    JSON.parse(
      await readFile(resolve(root, 'mobile.config.local.json'), 'utf8'),
    ),
  );
  const name = process.env.APP_ENV ?? 'development';
  if (!['development', 'staging'].includes(name))
    throw new Error('Unknown environment');
  const settings = config[name];
  if (!settings) throw new Error('Missing environment');
  const android = JSON.parse(
    await readFile(resolve(root, settings.androidServices), 'utf8'),
  );
  const apple = await readFile(resolve(root, settings.iosServices), 'utf8');
  validateNativeRegistration(settings.projectId, name, android, apple);
  if (settings.projectId.startsWith('demo-'))
    issues.push(
      'Real Firebase/App Check setup is pending; demo IDs are test-only',
    );
} catch {
  issues.push(
    'Local Firebase files and HTTPS legal-document configuration are missing or invalid',
  );
}
const xcode =
  spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' }).stdout ?? '';
if (!/Xcode 26\.(?:[4-9]|[1-9]\d)|Xcode (?:2[7-9]|[3-9]\d)\./.test(xcode))
  issues.push('Xcode 26.4+ required for Expo SDK 57');
const sdk =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  resolve(process.env.HOME ?? '', 'Library/Android/sdk');
try {
  await access(resolve(sdk, 'platforms/android-36/android.jar'));
} catch {
  issues.push('Android SDK platform 36 is missing');
}
if (issues.length) {
  for (const issue of issues) console.log(`Pending: ${issue}`);
  process.exitCode = 2;
} else
  console.log(
    'Local configuration checks passed. Native builds, App Check, legal review and physical-device testing remain separate gates.',
  );
