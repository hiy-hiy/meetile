import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { androidEnvironment } from './local-mobile.mjs';

const environment = await androidEnvironment(process.env);
const cwd = 'apps/mobile/android';
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
try {
  await access(`${cwd}/${wrapper}`);
} catch {
  throw new Error(
    'Generate the Android project first: pnpm local:android --build-only',
  );
}
const result = spawnSync(
  wrapper,
  [':proximity:testDebugUnitTest', '--build-cache', '--console=plain'],
  {
    cwd,
    env: { ...environment, APP_MODE: 'local', APP_ENV: 'development' },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(
  'Android FIT wire/state checks passed; physical radio and distance remain separate tests.',
);
