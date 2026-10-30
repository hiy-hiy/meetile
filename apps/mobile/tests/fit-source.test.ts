import { SimulatedProximity } from '../src/fit/simulated';
import { simulationAllowed } from '../src/fit/source';
import { judge, type Observation } from '../src/fit/policy';

test('simulation needs a development build that opted in', () => {
  const on = { dev: true, variant: 'development', simulatedProximity: true };
  expect(simulationAllowed(on)).toBe(true);
  expect(simulationAllowed({ ...on, dev: false })).toBe(false);
  expect(simulationAllowed({ ...on, variant: 'staging' })).toBe(false);
  expect(simulationAllowed({ ...on, variant: undefined })).toBe(false);
  expect(simulationAllowed({ ...on, simulatedProximity: false })).toBe(false);
});
describe('simulated source', () => {
  beforeEach(() => jest.useFakeTimers({ now: 10_000 }));
  afterEach(() => jest.useRealTimers());
  async function collect(scenario: 'near' | 'far' | 'multiple', ms: number) {
    const seen: Observation[] = [];
    const appear = jest.fn(async () => 'P'.repeat(22));
    const source = new SimulatedProximity(appear, scenario);
    await source.start('T'.repeat(22), (value) => seen.push(value), jest.fn());
    await jest.advanceTimersByTimeAsync(ms);
    source.stop();
    return { seen, appear };
  }
  test('near feeds observations that the real policy judges near after the hold time', async () => {
    const { seen, appear } = await collect('near', 3000);
    expect(appear).toHaveBeenCalledWith('T'.repeat(22));
    expect(judge(seen, Date.now())).toMatchObject({
      status: 'near',
      peerToken: 'P'.repeat(22),
    });
  });
  test('far and multiple scenarios are not near', async () => {
    expect(judge((await collect('far', 3000)).seen, Date.now()).status).toBe(
      'searching',
    );
    expect(
      judge((await collect('multiple', 3000)).seen, Date.now()).status,
    ).toBe('multiple');
  });
  test('stop ends emission and a failed appearance reports unsupported', async () => {
    const seen: Observation[] = [];
    const source = new SimulatedProximity(async () => 'P'.repeat(22));
    await source.start('T'.repeat(22), (v) => seen.push(v), jest.fn());
    await jest.advanceTimersByTimeAsync(1000);
    source.stop();
    const count = seen.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(seen.length).toBe(count);
    const unavailable = jest.fn();
    await new SimulatedProximity(async () => {
      throw new Error('no server');
    }).start('T'.repeat(22), jest.fn(), unavailable);
    expect(unavailable).toHaveBeenCalledWith('unsupported');
  });
});
