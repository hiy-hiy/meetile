import type { ExpoConfig } from 'expo/config';
import {
  localSettingsSchema,
  validateNativeRegistration,
} from './src/build-settings.ts';
import {
  appMode,
  localDeviceSchema,
  LOCAL_BUNDLE,
} from '../../tools/local-development/config.ts';
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const rawVariant: unknown = process.env.APP_ENV;
const variant = z
  .enum(['development', 'staging'])
  .default('development')
  .parse(rawVariant);
const mode = appMode(process.env.APP_MODE, variant);
const runtime =
  mode === 'local'
    ? localDeviceSchema.parse(
        JSON.parse(
          readFileSync(resolve(__dirname, 'local-runtime.local.json'), 'utf8'),
        ),
      )
    : null;
const file = resolve(__dirname, 'mobile.config.local.json');
const local: unknown =
  mode === 'cloud' && existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : null;
const variants = local === null ? null : localSettingsSchema.parse(local);
const settings = variants?.[variant];
if (runtime)
  validateNativeRegistration(
    runtime.projectId,
    'local',
    JSON.parse(readFileSync(runtime.androidServices, 'utf8')),
    readFileSync(runtime.iosServices, 'utf8'),
  );
const proximityMode = z
  .enum(['native', 'simulated'])
  .default(runtime ? 'simulated' : 'native')
  .parse(process.env.PROXIMITY_MODE);
if (proximityMode === 'simulated' && !runtime)
  throw new Error('Simulated proximity requires the local development runtime');
const configured = Boolean(settings);
const firebasePlugins: NonNullable<ExpoConfig['plugins']> = runtime
  ? [['@react-native-firebase/app', { ios: { disableSPM: true } }]]
  : settings
    ? [
        ['@react-native-firebase/app', { ios: { disableSPM: true } }],
        '@react-native-firebase/app-check',
      ]
    : ['./plugins/with-firebase-cocoapods.cjs'];
const config: ExpoConfig = {
  // One display name for every variant for now; bundle IDs still keep them apart.
  name: 'Meetile',
  slug: 'puzzle-sns',
  version: '0.0.0',
  scheme: runtime ? 'puzzle-sns-local' : `puzzle-sns-${variant}`,
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  runtimeVersion: { policy: 'fingerprint' },
  ios: {
    bundleIdentifier: runtime ? LOCAL_BUNDLE : `jp.puzzlesns.app.${variant}`,
    supportsTablet: false,
    ...(runtime || settings
      ? { googleServicesFile: (runtime ?? settings)!.iosServices }
      : {}),
    infoPlist: {
      NSCameraUsageDescription: '今日のパズルに使う写真を撮影します。',
      NSBluetoothAlwaysUsageDescription:
        '目の前の相手とFITするために、近くの端末を探します。',
      NSNearbyInteractionUsageDescription:
        '対応する端末同士のFITで、相手との近さを確認します。',
    },
  },
  android: {
    package: runtime ? LOCAL_BUNDLE : `jp.puzzlesns.app.${variant}`,
    allowBackup: false,
    ...(runtime || settings
      ? { googleServicesFile: (runtime ?? settings)!.androidServices }
      : {}),
    ...(settings?.icon
      ? {}
      : {
          adaptiveIcon: {
            foregroundImage: './assets/adaptive-icon.png',
            backgroundColor: '#000000',
          },
        }),
    permissions: ['CAMERA'],
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
    ],
  },
  // assets/brand holds the source SVGs; the PNGs are rendered from them (docs/UI_REDESIGN.md).
  icon: settings?.icon ?? './assets/icon.png',
  plugins: [
    'expo-router',
    'expo-dev-client',
    [
      'expo-camera',
      {
        cameraPermission: '今日のパズルに使う写真を撮影します。',
        recordAudioAndroid: false,
      },
    ],
    ['expo-secure-store', { configureAndroidBackup: false }],
    'expo-sqlite',
    'expo-sharing',
    // Local scheduled reminders only; remote push (FCM/APNs) is not configured yet.
    // Mods run last-registered-first, so the entitlement removal is listed before the plugin.
    './plugins/without-push-entitlement.cjs',
    ['expo-notifications', { enableBackgroundRemoteNotifications: false }],
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '16.4', useFrameworks: 'static' },
        android: {
          minSdkVersion: 31,
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          ...(runtime ? { usesCleartextTraffic: true } : {}),
        },
      },
    ],
    ...firebasePlugins,
    ['./plugins/with-local-runtime.cjs', { enabled: Boolean(runtime) }],
  ],
  extra: {
    variant,
    mode,
    // Only the local-development build has a server-side artificial counterpart.
    simulatedProximity: proximityMode === 'simulated',
    ...(runtime ? { localRuntime: runtime } : {}),
    configured,
    projectId: settings?.projectId ?? null,
    legal: settings?.legal ?? null,
    emulatorHost: settings?.emulatorHost ?? null,
    ...(settings?.easProjectId
      ? { eas: { projectId: settings.easProjectId } }
      : {}),
  },
};
// App Check debug tokens are native-build/local setup secrets, never serialized into extra or JS.
export default config;
