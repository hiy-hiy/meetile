import type { Edges } from '@puzzle-sns/contracts';

/** Photo-first dark palette: black ground, white type, one pastel for the person's own piece. */
export const colors = {
  bg: '#000000',
  surface: '#141414',
  raised: '#232323',
  pressed: '#323232',
  line: '#2A2A2A',
  text: '#FFFFFF',
  muted: '#A3A3A3',
  blank: '#2B2B2B',
  cut: '#000000',
  dot: '#3A3A3A',
  accent: '#FFA8D5',
  /** FIT sheet ground and ripple: the one scene that runs warmer than the rest. */
  fitWash: '#1F0E19',
  glow: '#FFD1E8',
  /** A photo that is still loading; lighter than `blank` so the two never look alike. */
  loading: '#3C3C3C',
  danger: '#FF7B7B',
  caution: '#FFD27A',
  cautionWash: '#2B2312',
  white: '#FFFFFF',
  black: '#000000',
} as const;
export const CELL = 100;
/** Clockwise outline. Round and square complements share one boundary profile. */
export function piecePath(edges: Edges): string {
  const sides = [edges.north, edges.east, edges.south, edges.west];
  let path = 'M 0 0';
  for (let side = 0; side < 4; side++) {
    const edge = sides[side];
    if (!edge) throw new RangeError('Missing edge');
    const depth = edge.endsWith('-out') ? -18 : 18;
    const point = (x: number, y: number): string => {
      const pairs = [
        [x, y],
        [100 - y, x],
        [100 - x, 100 - y],
        [y, 100 - x],
      ];
      const p = pairs[side];
      if (!p) throw new RangeError('Invalid side');
      return `${p[0]} ${p[1]}`;
    };
    path += ` L ${point(35, 0)}`;
    path += edge.startsWith('round')
      ? ` C ${point(35, depth)} ${point(65, depth)} ${point(65, 0)}`
      : ` L ${point(35, depth)} L ${point(65, depth)} L ${point(65, 0)}`;
    path += ` L ${point(100, 0)}`;
  }
  return path + ' Z';
}
