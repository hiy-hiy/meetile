import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (process.platform !== 'darwin')
  throw new Error('iOS compile checks require macOS and Xcode');
function run(args) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || 'xcrun failed');
  return result.stdout.trim();
}
const root = 'apps/mobile/modules/proximity';
const sdk = run(['--sdk', 'iphoneos', '--show-sdk-path']);
run([
  'swiftc',
  '-typecheck',
  '-sdk',
  sdk,
  '-target',
  'arm64-apple-ios16.4',
  `${root}/ios/FitWire.swift`,
  `${root}/ios/FitRadio.swift`,
]);
const temporary = mkdtempSync(join(tmpdir(), 'puzzle-fit-wire-'));
try {
  const executable = join(temporary, 'wire-tests');
  run([
    'swiftc',
    `${root}/ios/FitWire.swift`,
    `${root}/tests/main.swift`,
    '-o',
    executable,
  ]);
  const result = spawnSync(executable, [], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('FIT wire checks failed');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(
  'iOS radio SDK typecheck passed; Expo bridge linking and physical-device tests are separate.',
);
