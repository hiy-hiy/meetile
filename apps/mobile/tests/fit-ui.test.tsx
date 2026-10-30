import { act, fireEvent, render } from '@testing-library/react-native';
import { Text as MockText } from 'react-native';
import { FitEntry, FitPanel } from '../src/components/fit';
import { FitController } from '../src/fit/controller';
import type { MobileController, Snapshot } from '../src/controller';
import type { FitSnapshot } from '../src/fit/controller';

jest.mock('../src/components/board', () => ({
  BoardThumbnail: (props: { reveal?: boolean; ownPieceId: string | null }) => (
    <MockText>{`統合後の盤面:${props.reveal ? 'reveal' : 'still'}:${props.ownPieceId}`}</MockText>
  ),
}));

const state = (value: Partial<FitSnapshot>): FitSnapshot => ({
  stage: 'idle',
  sessionId: null,
  reason: null,
  preview: null,
  ...value,
});
function fakeFit(value: FitSnapshot) {
  return {
    subscribe: () => () => {},
    snapshot: () => value,
    start: jest.fn(async () => {}),
    leave: jest.fn(async () => {}),
    confirm: jest.fn(async () => {}),
    recheckDay: jest.fn(async () => {}),
  };
}
const preview = {
  sessionId: 's',
  visibility: 'visible',
  edges: {
    north: 'round-in',
    east: 'round-in',
    south: 'round-in',
    west: 'round-in',
  },
  username: 'Synthetic name',
  caption: 'Synthetic caption',
  imageBase64: 'AAAA',
} as const;
const panel = (value: FitSnapshot, onClose = jest.fn()) => {
  const fit = fakeFit(value);
  return {
    fit,
    onClose,
    screen: render(
      <FitPanel fit={fit as unknown as FitController} onClose={onClose} />,
    ),
  };
};

test('the preview shows only the counterpart and confirms or rejects them', () => {
  const { fit, onClose, screen } = panel(
    state({ stage: 'preview', sessionId: 's', preview }),
  );
  expect(fit.start).toHaveBeenCalled();
  expect(screen.getByText('Synthetic name')).toBeTruthy();
  expect(screen.getByText('Synthetic caption')).toBeTruthy();
  fireEvent.press(screen.getByText('この人とFITする'));
  expect(fit.confirm).toHaveBeenCalled();
  fireEvent.press(screen.getByText('違う人です'));
  expect(fit.leave).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});
test('a blank preview shows no personal content', () => {
  const blank = {
    ...preview,
    visibility: 'blank',
    username: null,
    caption: null,
    imageBase64: null,
  } as const;
  const { screen } = panel(
    state({ stage: 'preview', sessionId: 's', preview: blank }),
  );
  expect(screen.getByText('相手のピースは表示できません。')).toBeTruthy();
  expect(screen.queryByLabelText('相手のピース')).toBeNull();
});
test('each stage states what to do next', () => {
  const cases: [Partial<FitSnapshot>, RegExp][] = [
    [{ stage: 'searching' }, /10cmくらい/],
    [{ stage: 'multiple' }, /二人だけの状態/],
    [{ stage: 'conflict' }, /ほかの端末があったかも/],
    [{ stage: 'matched', sessionId: 's' }, /相手を確かめています/],
    [{ stage: 'waiting', sessionId: 's', preview }, /相手の確認を待って/],
    [{ stage: 'merged' }, /ひとつになりました/],
    [{ stage: 'not-merged' }, /今回は形が合いませんでした/],
    [{ stage: 'board-changed' }, /直前にパズルが育ち/],
    [{ stage: 'partner-left' }, /画面を離れました/],
    [{ stage: 'day-changed' }, /日付が切り替わりました/],
    [{ stage: 'already-connected' }, /もう同じパズルに入っています/],
    [{ stage: 'rate-limited' }, /しばらく待って/],
    [{ stage: 'unavailable', reason: 'permission' }, /許可をオン/],
    [{ stage: 'unavailable', reason: 'bluetooth-off' }, /Bluetoothをオン/],
  ];
  for (const [value, text] of cases) {
    const { screen } = panel(state(value));
    expect(screen.getByText(text)).toBeTruthy();
    screen.unmount();
  }
});
test('a finished attempt can be retried or closed', () => {
  const { fit, onClose, screen } = panel(state({ stage: 'timeout' }));
  fireEvent.press(screen.getByText('もう一度試す'));
  expect(fit.start).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByText('閉じる'));
  expect(onClose).toHaveBeenCalled();
  const merged = panel(state({ stage: 'merged' }));
  expect(merged.screen.queryByText('もう一度試す')).toBeNull();
  fireEvent.press(merged.screen.getByText('盤面を見る'));
  expect(merged.onClose).toHaveBeenCalled();
});
test('an unmatched shape explains the day without offering a retry; a changed board can retry', () => {
  const notMerged = panel(state({ stage: 'not-merged' }));
  expect(notMerged.screen.getByText(/パズルの一部です/)).toBeTruthy();
  expect(notMerged.screen.queryByText('もう一度試す')).toBeNull();
  expect(notMerged.screen.queryByText(/盤面は変わっていません/)).toBeNull();
  const changed = panel(state({ stage: 'board-changed' }));
  fireEvent.press(changed.screen.getByText('もう一度試す'));
  expect(changed.fit.start).toHaveBeenCalledTimes(2);
});
test('a successful FIT shows the combined board, and only then', () => {
  const board = { boardId: 'b', dayKey: '2026-10-10', version: 2, pieces: [] };
  const render_ = (stage: FitSnapshot['stage']) => {
    const fit = fakeFit(state({ stage }));
    return render(
      <FitPanel
        fit={fit as unknown as FitController}
        onClose={jest.fn()}
        board={board as never}
        uris={{}}
        ownPieceId="own"
      />,
    );
  };
  expect(render_('merged').getByText('統合後の盤面:reveal:own')).toBeTruthy();
  expect(render_('not-merged').queryByText(/統合後の盤面/)).toBeNull();
});
test('the steps follow the stage and a long search lists what to check', () => {
  jest.useFakeTimers();
  try {
    const { screen } = panel(state({ stage: 'searching' }));
    expect(screen.getByLabelText('手順 1 / 3：近づける')).toBeTruthy();
    expect(screen.queryByText('見つからないときは')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(15_000);
    });
    expect(screen.getByText('見つからないときは')).toBeTruthy();
    expect(screen.getByText(/Bluetoothはオンですか/)).toBeTruthy();
    const waiting = panel(state({ stage: 'waiting', sessionId: 's', preview }));
    expect(
      waiting.screen.getByLabelText('手順 3 / 3：二人で決める'),
    ).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

const today = (value: Partial<Snapshot>): Snapshot =>
  ({
    phase: 'today',
    day: {
      dayKey: '2026-10-10',
      serverTimeMs: 1,
      ownPieceId: 'p',
      boardId: 'b',
      photoState: 'ready',
    },
    board: { boardId: 'b', dayKey: '2026-10-10', version: 1, pieces: [{}] },
    ...value,
  }) as unknown as Snapshot;
test('FIT is offered only with a ready piece on an unfinished board', () => {
  const controller = {
    createFit: (source: null) =>
      new FitController({ call: jest.fn(async () => ({})) } as never, source),
    callPort: jest.fn(),
  } as unknown as MobileController;
  const offered = render(
    <FitEntry state={today({})} controller={controller} />,
  );
  expect(offered.getByText('FITする')).toBeTruthy();
  for (const closed of [
    today({ phase: 'capture' }),
    today({ day: { ...today({}).day!, photoState: 'not-created' } }),
    today({ board: { pieces: new Array(20).fill({}) } as never }),
  ]) {
    const screen = render(<FitEntry state={closed} controller={controller} />);
    expect(screen.queryByText('FITする')).toBeNull();
  }
});
test('without simulated proximity or native support the screen says it is unavailable', async () => {
  const controller = {
    createFit: (source: null) =>
      new FitController({ call: jest.fn(async () => ({})) } as never, source),
    callPort: jest.fn(),
  } as unknown as MobileController;
  const screen = render(<FitEntry state={today({})} controller={controller} />);
  fireEvent.press(screen.getByText('FITする'));
  expect(
    await screen.findByText('この端末では近くの端末を探せません'),
  ).toBeTruthy();
  expect(controller.callPort).not.toHaveBeenCalled();
});
