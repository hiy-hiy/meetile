import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDeviceSchema } from '../tools/local-development/config.ts';

const usage =
  'Usage: pnpm local:mobile [--platform ios|android] --device <iPhone identifier or Android device name> OR pnpm local:android --build-only';

export function mobileOptions(args) {
  const options = { platform: 'ios', device: null, buildOnly: false };
  const seen = new Set();
  const values = args.filter((value) => value !== '--');
  for (let i = 0; i < values.length; i++) {
    const flag = values[i];
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === '--platform' && ['ios', 'android'].includes(values[i + 1]))
      options.platform = values[++i];
    else if (
      flag === '--device' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(values[i + 1] ?? '')
    )
      options.device = values[++i];
    else if (flag === '--build-only') options.buildOnly = true;
    else throw new Error(usage);
  }
  if (
    options.buildOnly
      ? options.platform !== 'android' || options.device !== null
      : options.device === null
  )
    throw new Error(usage);
  return options;
}

export function mobileCommands(options) {
  const prebuild = {
    command: 'pnpm',
    args: [
      'exec',
      'expo',
      'prebuild',
      '--platform',
      options.platform,
      '--no-install',
    ],
    cwd: 'apps/mobile',
  };
  if (options.buildOnly)
    return [
      prebuild,
      {
        command: process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
        args: [
          ':app:assembleDebug',
          '--build-cache',
          '-PreactNativeArchitectures=arm64-v8a',
        ],
        cwd: 'apps/mobile/android',
      },
    ];
  return [
    prebuild,
    {
      command: 'pnpm',
      args: [
        'exec',
        'expo',
        `run:${options.platform}`,
        '--device',
        options.device,
        ...(options.platform === 'ios'
          ? ['--configuration', 'Debug']
          : ['--variant', 'debug']),
        '--port',
        '8082',
      ],
      cwd: 'apps/mobile',
    },
  ];
}

export async function androidEnvironment(environment) {
  const sdk = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME to the Android SDK directory');
  await access(join(sdk, 'platforms/android-36/android.jar'));
  if (!environment.JAVA_HOME)
    throw new Error(
      'Set JAVA_HOME to JDK 17 for Android builds (Emulators use JDK 21 separately)',
    );
  const java = spawnSync(
    join(environment.JAVA_HOME, 'bin', 'java'),
    ['-version'],
    {
      encoding: 'utf8',
    },
  );
  if (java.status !== 0 || !/version "17\./.test(java.stderr ?? ''))
    throw new Error('Android builds require JAVA_HOME pointing to JDK 17');
  // Bound native-build resource use and avoid retaining a JDK 17 daemon between runs.
  return {
    ...environment,
    ANDROID_HOME: sdk,
    GRADLE_OPTS: [
      environment.GRADLE_OPTS,
      '-Dorg.gradle.daemon=false',
      '-Dorg.gradle.workers.max=2',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

async function main() {
  const options = mobileOptions(process.argv.slice(2));
  localDeviceSchema.parse(
    JSON.parse(await readFile('apps/mobile/local-runtime.local.json', 'utf8')),
  );
  let env = { ...process.env, APP_MODE: 'local', APP_ENV: 'development' };
  if (options.platform === 'android') env = await androidEnvironment(env);
  for (const step of mobileCommands(options)) {
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
