import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mobileOptions,
  mobileCommands,
  androidEnvironment,
} from '../local-mobile.mjs';

test('existing iPhone invocation keeps its Debug configuration and Metro port', () => {
  const steps = mobileCommands(
    mobileOptions(['--device', 'iphone-identifier']),
  );
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[1].args, [
    'exec',
    'expo',
    'run:ios',
    '--device',
    'iphone-identifier',
    '--configuration',
    'Debug',
    '--port',
    '8082',
  ]);
});

test('Android launch selects an explicit device and Debug; build-only never installs or starts Metro', () => {
  const steps = mobileCommands(
    mobileOptions(['--platform', 'android', '--', '--device', 'Pixel_8']),
  );
  assert.deepEqual(steps[0].args, [
    'exec',
    'expo',
    'prebuild',
    '--platform',
    'android',
    '--no-install',
  ]);
  assert.deepEqual(steps[1].args, [
    'exec',
    'expo',
    'run:android',
    '--device',
    'Pixel_8',
    '--variant',
    'debug',
    '--port',
    '8082',
  ]);
  const build = mobileCommands(
    mobileOptions(['--platform', 'android', '--build-only']),
  );
  assert.equal(build[1].cwd, 'apps/mobile/android');
  assert.deepEqual(build[1].args, [
    ':app:assembleDebug',
    '--build-cache',
    '-PreactNativeArchitectures=arm64-v8a',
  ]);
});

test('refuses ambiguous targets, extra flags and release/configuration overrides', () => {
  for (const args of [
    [],
    ['--platform', 'windows', '--device', 'phone'],
    ['--device', '--variant'],
    ['--device', 'phone;echo'],
    ['--device', 'phone', '--variant', 'release'],
    ['--device', 'phone', '--platform', 'ios', '--platform', 'android'],
    ['--build-only'],
    ['--platform', 'android', '--build-only', '--device', 'phone'],
  ])
    assert.throws(() => mobileOptions(args), /Usage:/);
});

test('Android preparation requires SDK 36 and an explicit JDK 17, leaving the caller environment intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'puzzle-android-env-'));
  try {
    const sdk = join(root, 'sdk');
    const javaHome = join(root, 'jdk');
    await mkdir(join(sdk, 'platforms/android-36'), { recursive: true });
    await writeFile(join(sdk, 'platforms/android-36/android.jar'), 'fixture');
    await mkdir(join(javaHome, 'bin'), { recursive: true });
    const java = join(javaHome, 'bin/java');
    await writeFile(
      java,
      '#!/bin/sh\necho \'openjdk version "17.0.20"\' >&2\n',
      { mode: 0o700 },
    );
    const env = {
      ANDROID_SDK_ROOT: sdk,
      JAVA_HOME: javaHome,
      APP_ENV: 'development',
    };
    const prepared = await androidEnvironment(env);
    assert.equal(prepared.ANDROID_HOME, sdk);
    assert.match(prepared.GRADLE_OPTS, /-Dorg.gradle.workers.max=2/);
    assert.match(prepared.GRADLE_OPTS, /-Dorg.gradle.daemon=false/);
    assert.equal(env.ANDROID_HOME, undefined);
    await assert.rejects(
      androidEnvironment({ JAVA_HOME: javaHome }),
      /ANDROID_HOME/,
    );
    await assert.rejects(
      androidEnvironment({ ANDROID_HOME: sdk }),
      /JAVA_HOME/,
    );
    await assert.rejects(
      androidEnvironment({
        ANDROID_HOME: join(root, 'absent'),
        JAVA_HOME: javaHome,
      }),
    );
    await writeFile(java, '#!/bin/sh\necho \'openjdk version "21.0.2"\' >&2\n');
    await assert.rejects(androidEnvironment(env), /JDK 17/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
