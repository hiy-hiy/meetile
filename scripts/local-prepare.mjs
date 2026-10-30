import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  localDeviceSchema,
  LOCAL_PROJECT,
  LOCAL_BUNDLE,
} from '../tools/local-development/config.ts';

const args = process.argv.slice(2).filter((value) => value !== '--');
if (args.length !== 2 || args[0] !== '--host')
  throw new Error('Usage: pnpm local:prepare --host <Mac private IPv4>');
const directory = resolve('.tools/local-runtime/mobile');
const settings = localDeviceSchema.parse({
  mode: 'local',
  projectId: LOCAL_PROJECT,
  host: args[1],
  iosServices: resolve(directory, 'GoogleService-Info.plist'),
  androidServices: resolve(directory, 'google-services.json'),
});
await mkdir(directory, { recursive: true });
// Synthetic emulator-only registration. These are not keys for any real Firebase project.
const apiKey = 'AIzaSy' + '0'.repeat(33);
await writeFile(
  settings.iosServices,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>API_KEY</key><string>${apiKey}</string>
<key>GCM_SENDER_ID</key><string>100000000000</string>
<key>PLIST_VERSION</key><string>1</string>
<key>BUNDLE_ID</key><string>${LOCAL_BUNDLE}</string>
<key>PROJECT_ID</key><string>${LOCAL_PROJECT}</string>
<key>STORAGE_BUCKET</key><string>${LOCAL_PROJECT}.appspot.com</string>
<key>GOOGLE_APP_ID</key><string>1:100000000000:ios:0000000000000000000000</string>
<key>IS_ANALYTICS_ENABLED</key><false/>
<key>IS_ADS_ENABLED</key><false/>
</dict></plist>\n`,
  { mode: 0o600 },
);
await writeFile(
  settings.androidServices,
  JSON.stringify(
    {
      project_info: {
        project_number: '100000000000',
        project_id: LOCAL_PROJECT,
        storage_bucket: `${LOCAL_PROJECT}.appspot.com`,
      },
      client: [
        {
          client_info: {
            mobilesdk_app_id: '1:100000000000:android:0000000000000000000000',
            android_client_info: { package_name: LOCAL_BUNDLE },
          },
          api_key: [{ current_key: apiKey }],
          services: {},
        },
      ],
      configuration_version: '1',
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
await writeFile(
  'apps/mobile/local-runtime.local.json',
  JSON.stringify(settings, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(
  `Local-only configuration prepared for ${settings.host}; cloud configuration unchanged.`,
);
