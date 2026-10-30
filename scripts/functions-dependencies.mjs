import { createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export async function ensureFunctionsDependencies() {
  const root = 'apps/functions/deploy';
  const digest = createHash('sha256')
    .update(await readFile(`${root}/package-lock.json`))
    .digest('hex');
  try {
    if ((await readFile(`${root}/.installed-lock`, 'utf8')) === digest) {
      await access(`${root}/node_modules/firebase-functions/package.json`);
      return;
    }
  } catch {
    /* First build or cleared dependencies. */
  }
  const result = spawnSync(
    'npm',
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0)
    throw new Error('Failed to install isolated Functions dependencies');
  await writeFile(`${root}/.installed-lock`, digest);
}
