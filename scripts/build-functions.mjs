import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { isDeepStrictEqual } from 'node:util';

const manifest = JSON.parse(
  await readFile('apps/functions/package.json', 'utf8'),
);
const deployment = {
  name: 'puzzle-sns-backend',
  version: manifest.version,
  private: true,
  main: 'index.js',
  engines: { node: '22' },
  dependencies: {
    'firebase-admin': manifest.dependencies['firebase-admin'],
    'firebase-functions': manifest.dependencies['firebase-functions'],
    '@google-cloud/vision': manifest.dependencies['@google-cloud/vision'],
    '@google-cloud/language': manifest.dependencies['@google-cloud/language'],
    sharp: manifest.dependencies.sharp,
  },
};
const output = 'apps/functions/deploy';
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['apps/functions/src/index.ts'],
  outfile: `${output}/index.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: [
    'firebase-admin/*',
    'firebase-functions/*',
    '@google-cloud/vision',
    '@google-cloud/language',
    'sharp',
  ],
  metafile: true,
}).then(async (result) => {
  await writeFile(
    `${output}/bundle.meta.json`,
    JSON.stringify(result.metafile, null, 2) + '\n',
  );
});
await writeFile(
  `${output}/package.json`,
  JSON.stringify(deployment, null, 2) + '\n',
);
const lock = JSON.parse(
  await readFile('firebase/functions.package-lock.json', 'utf8'),
);
if (!isDeepStrictEqual(lock.packages[''].dependencies, deployment.dependencies))
  throw new Error('Deployment lock dependencies differ');
await copyFile(
  'firebase/functions.package-lock.json',
  `${output}/package-lock.json`,
);
console.log(
  'Functions bundle includes contracts, engine and Zod; runtime SDKs stay external.',
);
