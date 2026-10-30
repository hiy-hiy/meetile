import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runSimulation } from './simulate';
import { renderBoardsSvg } from './svg';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string', default: '42' },
      trials: { type: 'string', default: '100' },
      participants: { type: 'string', default: '20' },
      output: { type: 'string', default: 'artifacts/simulation' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'pnpm simulate --seed <uint32> --trials <1..10000> --participants <1..20> --output <directory>',
    );
    return;
  }
  const report = runSimulation({
    seed: Number(values.seed),
    trials: Number(values.trials),
    participants: Number(values.participants),
  });
  await mkdir(values.output, { recursive: true });
  await writeFile(
    join(values.output, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    join(values.output, 'boards.svg'),
    renderBoardsSvg(report.example),
  );
  console.log(
    JSON.stringify(
      report,
      (key, value: unknown) => (key === 'example' ? undefined : value),
      2,
    ),
  );
  console.log(
    `Synthetic artifacts: ${values.output}/report.json and boards.svg`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Simulation failed');
  process.exitCode = 1;
});
