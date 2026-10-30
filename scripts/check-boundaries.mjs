import { readFile, readdir } from 'node:fs/promises';

const allowed = {
  contracts: new Set([
    'zod',
    'unicode-segmenter',
    'unicode-segmenter/grapheme',
  ]),
  'puzzle-engine': new Set(['@puzzle-sns/contracts']),
};
for (const [name, dependencies] of Object.entries(allowed)) {
  const root = `packages/${name}`;
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!dependencies.has(dependency))
      throw new Error(`Unexpected ${name} dependency: ${dependency}`);
  }
  for (const entry of await readdir(`${root}/src`, { recursive: true })) {
    if (!entry.endsWith('.ts')) continue;
    const source = await readFile(`${root}/src/${entry}`, 'utf8');
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g,
    )) {
      if (!match[1].startsWith('.') && !dependencies.has(match[1])) {
        throw new Error(`Unexpected ${name} import: ${match[1]}`);
      }
    }
    if (/Math\.random\s*\(|Date\s*\.|new\s+Date\s*\(/.test(source)) {
      throw new Error(`Implicit entropy or clock in ${name}/${entry}`);
    }
  }
}
console.log('Pure package boundaries verified.');
