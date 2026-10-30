import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { proximitySource } from '../src/fit/factory';
import { NativeProximity } from '../src/fit/native';
import { SimulatedProximity } from '../src/fit/simulated';
import type { MobileController } from '../src/controller';
jest.mock('expo-crypto', () => ({ randomUUID: () => 'factory-test-run' }));
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<typeof import('expo-modules-core')>(
    'expo-modules-core',
  ),
  requireOptionalNativeModule: jest.fn(),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} } },
}));
const controller = { callPort: jest.fn() } as unknown as MobileController;
const native = { start: jest.fn(), stop: jest.fn(), addListener: jest.fn() };
beforeEach(() => {
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(native);
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
});
function configure(extra: Record<string, unknown>) {
  Object.assign(Constants, { expoConfig: { extra } });
}
test('iOS gets the real radio unless local simulation explicitly opts in', () => {
  configure({
    variant: 'development',
    mode: 'local',
    simulatedProximity: false,
  });
  expect(proximitySource(controller)).toBeInstanceOf(NativeProximity);
  configure({
    variant: 'development',
    mode: 'local',
    simulatedProximity: true,
  });
  expect(proximitySource(controller)).toBeInstanceOf(SimulatedProximity);
  configure({ variant: 'staging', mode: 'cloud', simulatedProximity: false });
  expect(proximitySource(controller)).toBeInstanceOf(NativeProximity);
});
test('unsupported builds and invalid environments never invent a peer', () => {
  configure({ variant: 'staging', mode: 'cloud', simulatedProximity: true });
  expect(proximitySource(controller)).toBeNull();
  configure({ variant: 'unknown', simulatedProximity: false });
  expect(proximitySource(controller)).toBeNull();
  configure({ variant: 'development', simulatedProximity: false });
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(null);
  expect(proximitySource(controller)).toBeNull();
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: 'android',
  });
  expect(proximitySource(controller)).toBeNull();
});

test('Android selects the native radio and keeps simulation opt-in', () => {
  Object.defineProperty(Platform, 'OS', {
    configurable: true,
    value: 'android',
  });
  configure({
    variant: 'development',
    mode: 'local',
    simulatedProximity: false,
  });
  expect(proximitySource(controller)).toBeInstanceOf(NativeProximity);
  configure({
    variant: 'development',
    mode: 'local',
    simulatedProximity: true,
  });
  expect(proximitySource(controller)).toBeInstanceOf(SimulatedProximity);
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  configure({ variant: 'development', simulatedProximity: false });
  expect(proximitySource(controller)).toBeNull();
});
