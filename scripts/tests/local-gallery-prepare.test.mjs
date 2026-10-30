import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { prepareGallery } from '../local-gallery-prepare.mjs';

test('prepares private relative asset references; rejected input preserves existing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gallery-prepare-'));
  try {
    const image = join(root, 'artificial.png');
    const output = join(root, 'output');
    // One-pixel artificial PNG, never a person or user photograph.
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9VkAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const paths = Array(12).fill(image);
    await prepareGallery(paths, output);
    const manifest = await readFile(join(output, 'index.cjs'), 'utf8');
    assert.equal((await readdir(output)).length, 13);
    assert.equal((manifest.match(/require\(/g) ?? []).length, 12);
    assert.ok(manifest.includes("require('./01.png')"));
    assert.ok(!manifest.includes(root));
    assert.deepEqual(
      await readFile(join(output, '12.png')),
      await readFile(image),
    );
    await assert.rejects(prepareGallery(paths.slice(1), output));
    const invalid = join(root, 'invalid.jpg');
    await writeFile(invalid, 'not an image');
    await assert.rejects(prepareGallery([...paths.slice(1), invalid], output));
    assert.equal(await readFile(join(output, 'index.cjs'), 'utf8'), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
