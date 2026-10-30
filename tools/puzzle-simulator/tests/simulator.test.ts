import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardGeometrySchema } from '@puzzle-sns/contracts';
import { validateBoard } from '@puzzle-sns/puzzle-engine';
import { runSimulation } from '../src/simulate';
import { renderBoardsSvg } from '../src/svg';

test('simulation reproduces synthetic partitions, counts and valid boards', () => {
  const options = { seed: 42, trials: 4, participants: 20 };
  const report = runSimulation(options);
  expect(report).toEqual(runSimulation(options));
  expect(report.attempts).toBe(
    report.successes +
      Object.values(report.failures).reduce((a, b) => a + b, 0),
  );
  expect(
    Object.entries(report.finalSizeDistribution).reduce(
      (total, [size, count]) => total + Number(size) * count,
      0,
    ),
  ).toBe(80);
  expect(report.example.flatMap((board) => board.participantKeys)).toHaveLength(
    20,
  );
  expect(
    new Set(report.example.flatMap((board) => board.participantKeys)).size,
  ).toBe(20);
  for (const board of report.example)
    expect(validateBoard(board)).toEqual(board);
  const svg = renderBoardsSvg(report.example);
  expect((svg.match(/<path /g) ?? []).length).toBe(20);
  expect(svg).toContain('Synthetic puzzle geometry simulation');
});

test.each([
  { seed: 0, trials: 0, participants: 2 },
  { seed: 0, trials: 10001, participants: 2 },
  { seed: 0, trials: 0.5, participants: 2 },
  { seed: 0, trials: 1, participants: 0 },
  { seed: 0, trials: 1, participants: 21 },
  { seed: -1, trials: 1, participants: 2 },
])('rejects invalid simulation options %#', (options) => {
  expect(() => runSimulation(options)).toThrow();
});

test('one participant stays a singleton without attempts', () => {
  const report = runSimulation({ seed: 0, trials: 3, participants: 1 });
  expect(report.attempts).toBe(0);
  expect(report.finalSizeDistribution).toEqual({ '1': 3 });
});

test('SVG escapes identifiers, renders round and square sides, and rejects an empty input', () => {
  const board = boardGeometrySchema.parse({
    pieces: [
      {
        id: '<script>"\'&',
        position: { x: -2, y: -2 },
        edges: {
          north: 'round-out',
          east: 'round-in',
          south: 'square-out',
          west: 'square-in',
        },
      },
    ],
    participantKeys: ['synthetic'],
  });
  const svg = renderBoardsSvg([board]);
  expect(svg).toContain('&lt;script&gt;&quot;&apos;&amp;');
  expect(svg).not.toContain('<script>');
  expect(svg).toContain('C ');
  expect(svg).toContain('L ');
  expect(() => renderBoardsSvg([])).toThrow(RangeError);
});

test('compiled CLI writes deterministic JSON and SVG, shows help, and rejects invalid arguments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'puzzle-sns-simulation-'));
  const cli = resolve('tools/puzzle-simulator/dist/cli.js');
  try {
    const args = [
      cli,
      '--seed',
      '73',
      '--trials',
      '2',
      '--participants',
      '6',
      '--output',
      directory,
    ];
    execFileSync(process.execPath, args);
    const json = readFileSync(join(directory, 'report.json'), 'utf8');
    const svg = readFileSync(join(directory, 'boards.svg'), 'utf8');
    expect(json).toContain('synthetic-');
    expect(svg).toContain('<svg');
    execFileSync(process.execPath, args);
    expect(readFileSync(join(directory, 'report.json'), 'utf8')).toBe(json);
    expect(readFileSync(join(directory, 'boards.svg'), 'utf8')).toBe(svg);
    expect(
      execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }),
    ).toContain('pnpm simulate');
    const invalid = spawnSync(process.execPath, [cli, '--participants', '21'], {
      encoding: 'utf8',
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('participants');
    const unknown = spawnSync(process.execPath, [cli, '--unknown'], {
      encoding: 'utf8',
    });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown option');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
