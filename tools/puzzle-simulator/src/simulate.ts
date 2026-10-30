import {
  MAX_PIECES,
  type BoardGeometry,
  type MergeFailureReason,
} from '@puzzle-sns/contracts';
import {
  createSeededRandom,
  generatePiece,
  mergeBoards,
} from '@puzzle-sns/puzzle-engine';

export interface SimulationOptions {
  readonly seed: number;
  readonly trials: number;
  readonly participants: number;
}
export interface SimulationReport extends SimulationOptions {
  readonly attempts: number;
  readonly successes: number;
  readonly failures: Readonly<Record<MergeFailureReason, number>>;
  readonly contactDistribution: Readonly<Record<string, number>>;
  readonly finalSizeDistribution: Readonly<Record<string, number>>;
  readonly example: readonly BoardGeometry[];
}

function increment(histogram: Record<string, number>, value: number): void {
  const key = String(value);
  histogram[key] = (histogram[key] ?? 0) + 1;
}

/** Synthetic offline geometry experiment only; this is not an offline FIT feature. */
export function runSimulation(options: SimulationOptions): SimulationReport {
  const random = createSeededRandom(options.seed);
  if (
    !Number.isInteger(options.trials) ||
    options.trials < 1 ||
    options.trials > 10_000
  ) {
    throw new RangeError('trials must be an integer from 1 to 10000');
  }
  if (
    !Number.isInteger(options.participants) ||
    options.participants < 1 ||
    options.participants > MAX_PIECES
  ) {
    throw new RangeError('participants must be an integer from 1 to 20');
  }
  let attempts = 0;
  let successes = 0;
  const failures: Record<MergeFailureReason, number> = {
    'duplicate-participants': 0,
    'duplicate-pieces': 0,
    'piece-limit': 0,
    'no-placement': 0,
  };
  const contactDistribution: Record<string, number> = {};
  const finalSizeDistribution: Record<string, number> = {};
  let example: readonly BoardGeometry[] = [];
  for (let trial = 0; trial < options.trials; trial++) {
    let boards: BoardGeometry[] = Array.from(
      { length: options.participants },
      (_, participant) => {
        const id = `synthetic-${trial}-${participant}`;
        return {
          pieces: [generatePiece(id, random)],
          participantKeys: [`member-${id}`],
        };
      },
    );
    const tried = new Set<string>();
    while (boards.length > 1) {
      const pairs: { a: number; b: number; key: string }[] = [];
      for (let a = 0; a < boards.length; a++) {
        for (let b = a + 1; b < boards.length; b++) {
          const first = boards[a];
          const second = boards[b];
          if (!first || !second) throw new Error('Missing synthetic board');
          const key = JSON.stringify([
            first.participantKeys,
            second.participantKeys,
          ]);
          if (!tried.has(key)) pairs.push({ a, b, key });
        }
      }
      if (pairs.length === 0) break;
      const pair = pairs[Math.floor(random() * pairs.length)];
      if (!pair) throw new Error('Missing synthetic pair');
      const first = boards[pair.a];
      const second = boards[pair.b];
      if (!first || !second) throw new Error('Missing synthetic board');
      tried.add(pair.key);
      attempts++;
      const result = mergeBoards(
        first,
        second,
        Math.floor(random() * 0x1_0000_0000),
      );
      if (result.status === 'merged') {
        successes++;
        increment(contactDistribution, result.placement.contactCount);
        boards = boards.filter(
          (_, index) => index !== pair.a && index !== pair.b,
        );
        boards.push(result.board);
      } else {
        failures[result.reason]++;
      }
    }
    for (const board of boards)
      increment(finalSizeDistribution, board.pieces.length);
    if (trial === 0) example = boards;
  }
  return {
    ...options,
    attempts,
    successes,
    failures,
    contactDistribution,
    finalSizeDistribution,
    example,
  };
}
