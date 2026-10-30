import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  symlink,
  lstat,
  realpath,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { ensureFunctionsDependencies } from './functions-dependencies.mjs';

await ensureFunctionsDependencies();
const output = resolve('.tools/local-runtime/functions');
await mkdir(output, { recursive: true });
const result = await build({
  entryPoints: ['apps/functions/src/index.local.ts'],
  outfile: `${output}/index.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['firebase-functions/*', 'firebase-admin/*', 'sharp'],
  metafile: true,
});
if (
  Object.keys(result.metafile.inputs).some((file) =>
    /services\/photo-processor\.ts|@google-cloud\/(vision|language)/.test(file),
  ) ||
  Object.values(result.metafile.outputs).some((output) =>
    output.imports.some((item) =>
      /@google-cloud\/(vision|language)/.test(item.path),
    ),
  )
)
  throw new Error('External moderation entered local artifact');
await writeFile(
  `${output}/bundle.meta.json`,
  JSON.stringify(result.metafile, null, 2) + '\n',
);
for (const name of ['package.json', 'package-lock.json'])
  await copyFile(`apps/functions/deploy/${name}`, `${output}/${name}`);
const dependencies = resolve('apps/functions/deploy/node_modules');
try {
  await lstat(`${output}/node_modules`);
  if (
    (await realpath(`${output}/node_modules`)) !==
    (await realpath(dependencies))
  )
    throw new Error('Unexpected local dependency directory');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await symlink(dependencies, `${output}/node_modules`, 'dir');
}
const cloud = JSON.parse(
  await readFile('apps/functions/deploy/bundle.meta.json', 'utf8'),
);
if (
  Object.keys(cloud.inputs).some(
    (file) =>
      file.endsWith('index.local.ts') ||
      file.includes('apps/functions/src/local/') ||
      file.includes('tools/local-development/'),
  )
)
  throw new Error('Local code found in cloud artifact');
console.log(
  'Local session functions built separately; cloud artifact excludes local entry.',
);
