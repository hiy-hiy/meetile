import { EDGE_KINDS } from '@puzzle-sns/contracts';
import { piecePath } from '../src';
test('draws every shape without changing the fixed orientation', () => {
  const paths = new Set<string>();
  for (const north of EDGE_KINDS)
    for (const east of EDGE_KINDS)
      for (const south of EDGE_KINDS)
        for (const west of EDGE_KINDS) {
          const path = piecePath({ north, east, south, west });
          expect(path.startsWith('M 0 0')).toBe(true);
          expect(path.endsWith(' Z')).toBe(true);
          expect(path).not.toMatch(/NaN|undefined/);
          paths.add(path);
        }
  expect(paths.size).toBe(256);
});
