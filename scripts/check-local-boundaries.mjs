import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const cloud = JSON.parse(
  await readFile('apps/functions/deploy/bundle.meta.json', 'utf8'),
);
if (
  Object.keys(cloud.inputs).some((name) =>
    /index\.local\.ts|apps\/functions\/src\/local\/|tools\/local-development/.test(
      name,
    ),
  )
)
  throw new Error('Local server code entered the cloud artifact');
const output = resolve('.tools/local-boundaries/cloud-mobile');
const env = {
  ...process.env,
  APP_MODE: 'cloud',
  APP_ENV: 'development',
  CI: '1',
};
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'expo',
    'export',
    '--platform',
    'ios',
    '--platform',
    'android',
    '--source-maps',
    '--output-dir',
    output,
    '--clear',
  ],
  { cwd: 'apps/mobile', env, stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const maps = (await readdir(output, { recursive: true })).filter((file) =>
  file.endsWith('.map'),
);
if (maps.length !== 2)
  throw new Error('Expected both native platform source maps');
for (const file of maps) {
  const map = JSON.parse(await readFile(resolve(output, file), 'utf8'));
  if (
    map.sources.some((source) =>
      /src\/local\/|tools\/local-development\//.test(source),
    )
  )
    throw new Error(`Local modules entered cloud mobile bundle: ${file}`);
  if (!map.sources.some((source) => /src\/cloud\/today\.tsx/.test(source)))
    throw new Error('Cloud Today entry missing from cloud bundle');
}
console.log(
  'Cloud Functions and both native platform bundles exclude local runtime modules.',
);
