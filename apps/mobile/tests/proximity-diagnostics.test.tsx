import { useMemo } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { ProximityDiagnosticPanel } from '../src/local/proximity-diagnostics';
import {
  diagnosticsEnabled,
  fitTrialTimer,
  observeFit,
  observeProximity,
  proximityDiagnostics,
} from '../src/local/proximity-observer';
import { observeFit as productObserveFit } from '../src/cloud/proximity-observer';
import type { FitStage } from '../src/fit/machine';

jest.mock('expo-crypto', () => ({
  randomUUID: () => 'survey-run',
  getRandomBytes: () => new Uint8Array(16),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} } },
}));
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<typeof import('expo-modules-core')>(
    'expo-modules-core',
  ),
  requireOptionalNativeModule: jest.fn(),
}));
function configure(mode: string, variant: string, native: boolean) {
  Object.assign(Constants, { expoConfig: { extra: { mode, variant } } });
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    localBuildEnabled: () => native,
  });
}
test('cloud, staging and a binary without local registration cannot expose diagnostics', () => {
  for (const args of [
    ['cloud', 'development', true],
    ['local', 'staging', true],
    ['local', 'development', false],
  ] as const) {
    configure(args[0], args[1], args[2]);
    expect(diagnosticsEnabled()).toBe(false);
    const screen = render(<ProximityDiagnosticPanel />);
    expect(screen.queryByLabelText('開発用の近接観測')).toBeNull();
    screen.unmount();
  }
});
/** Details beyond the status line are collapsed until the developer opens them. */
function openDetails(screen: ReturnType<typeof render>) {
  expect(screen.queryByText(/無線停止はOSでも照合/)).toBeNull();
  fireEvent.press(screen.getByLabelText('近接観測の詳細を開く'));
}
test('a local Debug binary displays only coarse status and explicitly leaves OS verification separate', async () => {
  configure('local', 'development', true);
  const source = observeProximity(
    { start: async () => {}, stop: async () => true },
    'native',
  )!;
  const screen = render(<ProximityDiagnosticPanel />);
  openDetails(screen);
  await act(async () => {
    await source.start(
      'private-token',
      () => {},
      () => {},
    );
  });
  expect(screen.getByText('入力：native')).toBeTruthy();
  expect(screen.getByText('状態：開始要求済み・受信待ち')).toBeTruthy();
  await act(async () => {
    await source.stop();
  });
  expect(screen.getByText('状態：停止処理の応答あり')).toBeTruthy();
  expect(screen.getByText(/無線停止はOSでも照合/)).toBeTruthy();
  expect(JSON.stringify(proximityDiagnostics.snapshot())).not.toContain(
    'private-token',
  );
  screen.unmount();
});

test('opening FIT while the panel is shown updates the input without a render-phase update', async () => {
  configure('local', 'development', true);
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  function Opener({ input }: { input: 'native' | 'simulated' }) {
    // Mirrors FitEntry: the source is created inside useMemo during render.
    useMemo(
      () =>
        observeProximity(
          { start: async () => {}, stop: async () => true },
          input,
        ),
      [input],
    );
    return null;
  }
  try {
    const screen = render(
      <>
        <ProximityDiagnosticPanel />
        <Opener input="native" />
      </>,
    );
    openDetails(screen);
    await act(async () => {
      screen.rerender(
        <>
          <ProximityDiagnosticPanel />
          <Opener input="simulated" />
        </>,
      );
    });
    expect(screen.getByText('入力：疑似近接（電波ではない）')).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
    screen.unmount();
  } finally {
    error.mockRestore();
  }
});

test('Release disables diagnostics even when local settings and native registration are present', () => {
  configure('local', 'development', true);
  const original = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');
  try {
    Object.defineProperty(globalThis, '__DEV__', {
      configurable: true,
      value: false,
    });
    expect(diagnosticsEnabled()).toBe(false);
    const screen = render(<ProximityDiagnosticPanel />);
    expect(screen.queryByLabelText('開発用の近接観測')).toBeNull();
    screen.unmount();
  } finally {
    if (original) Object.defineProperty(globalThis, '__DEV__', original);
  }
});

test('the RSSI survey is unavailable while FIT owns the radio and runs alone otherwise', async () => {
  const module = {
    localBuildEnabled: () => true,
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    addListener: jest.fn(() => ({ remove() {} })),
  };
  Object.assign(Constants, {
    expoConfig: { extra: { mode: 'local', variant: 'development' } },
  });
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(module);
  const fit = observeProximity(
    { start: async () => {}, stop: async () => true },
    'native',
  )!;
  const screen = render(<ProximityDiagnosticPanel />);
  openDetails(screen);
  await act(async () => {
    await fit.start(
      'fit-token',
      () => {},
      () => {},
    );
  });
  const button = screen.getByRole('button', { name: /RSSI測定/ });
  const disabled = () =>
    (button.props.accessibilityState as { disabled: boolean }).disabled;
  expect(disabled()).toBe(true);
  await act(async () => {
    await fit.stop();
  });
  expect(disabled()).toBe(false);
  await act(async () => {
    fireEvent.press(button);
  });
  expect(module.start).toHaveBeenCalledWith(
    'AAAAAAAAAAAAAAAAAAAAAA',
    'BD1E4000-0E40-4CB6-AF31-8B034F29A718',
    'survey-run',
  );
  expect(screen.getByText(/#1 測定中/)).toBeTruthy();
  screen.unmount();
  // Leaving the screen ends the survey's radio run.
  expect(module.stop).toHaveBeenCalledWith('survey-run');
});

function stageSource() {
  let stage: FitStage = 'idle';
  const listeners = new Set<() => void>();
  const subscribe = jest.fn((listener: () => void) => listeners.add(listener));
  return {
    subscribe,
    snapshot: () => ({ stage }),
    go(next: FitStage) {
      stage = next;
      for (const listener of listeners) listener();
    },
  };
}
test('the trial timer shows search-to-preview time only in a local Debug binary', async () => {
  configure('local', 'development', false);
  const ignored = stageSource();
  expect(observeFit(ignored)).toBe(ignored);
  expect(ignored.subscribe).not.toHaveBeenCalled();
  const product = stageSource();
  expect(productObserveFit(product)).toBe(product);
  expect(product.subscribe).not.toHaveBeenCalled();

  configure('local', 'development', true);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const fit = observeFit(stageSource());
    const screen = render(<ProximityDiagnosticPanel />);
    openDetails(screen);
    const before = fitTrialTimer.snapshot().number;
    await act(async () => {
      fit.go('searching');
      fit.go('preview');
    });
    expect(
      screen.getByText(
        new RegExp(`試行#${before + 1}：相手のピース表示まで \\d+\\.\\d秒`),
      ),
    ).toBeTruthy();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[FIT試行\] (ios|android) 試行#\d+：相手のピース表示まで/,
      ),
    );
    screen.unmount();
  } finally {
    log.mockRestore();
  }
});
