import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const destination = fileURLToPath(
  new URL(
    '../apps/mobile/src/local/gallery-demo/assets.local/',
    import.meta.url,
  ),
);

/** Only explicitly supplied images are read; source names never enter the manifest. */
export async function prepareGallery(paths, output = destination) {
  if (paths.length !== 12)
    throw new Error(
      'Usage: pnpm local:gallery-prepare -- <12 image paths in display order>',
    );
  const images = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      const header = bytes.subarray(0, 12).toString('hex');
      const extension = header.startsWith('ffd8ff')
        ? 'jpg'
        : header.startsWith('89504e470d0a1a0a')
          ? 'png'
          : header.startsWith('52494646') &&
              bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'webp'
            : null;
      if (!extension)
        throw new Error('Each screenshot image must be JPEG, PNG or WebP');
      return { bytes, extension };
    }),
  );
  await mkdir(output, { recursive: true });
  const names = images.map(
    ({ extension }, index) =>
      `${String(index + 1).padStart(2, '0')}.${extension}`,
  );
  for (const [index, image] of images.entries())
    await writeFile(resolve(output, names[index]), image.bytes, {
      mode: 0o600,
    });
  await writeFile(
    resolve(output, 'index.cjs'),
    `// Private screenshot assets. Generated locally; do not commit.\nexports.demoPhotos = [\n${names.map((name) => `  require('./${name}'),`).join('\n')}\n];\n`,
    { mode: 0o600 },
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await prepareGallery(process.argv.slice(2).filter((arg) => arg !== '--'));
  console.log(
    'Prepared 12 private screenshot assets. Restart local Metro to enable 撮影用ギャラリー.',
  );
}
