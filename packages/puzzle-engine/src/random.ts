import { seedSchema } from '@puzzle-sns/contracts';

export type RandomSource = () => number;

/** Mulberry32 for reproducible selection/simulation, not for proximity or secret tokens. */
export function createSeededRandom(seed: number): RandomSource {
  let state = seedSchema.parse(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function randomIndex(length: number, random: RandomSource): number {
  if (!Number.isSafeInteger(length) || length < 1)
    throw new RangeError('Invalid choice count');
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('Random source must return a finite number in [0, 1)');
  }
  return Math.floor(value * length);
}
