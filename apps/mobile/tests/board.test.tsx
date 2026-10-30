import { act, fireEvent, render, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { Board, BoardThumbnail } from '../src/components/board';
import { artificialBoard } from './fixtures/board';
import { Gallery } from '../src/components/gallery';
import { demoGallerySource } from '../src/local/gallery-demo/data';
import { DemoGallery } from '../src/local/gallery-demo/screen';

jest.mock('../src/components/share-board', () => ({
  ShareBoardButton: () => null,
}));

const mockTiming = jest.fn((value: number) => value);
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView:
    jest.requireActual<typeof import('react-native')>('react-native').View,
}));
let mockTap:
  ((event: { x: number; y: number }, success: boolean) => void) | undefined;
jest.mock('@shopify/react-native-skia', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Canvas: View,
    Group: View,
    Image: View,
    Path: View,
    useImage: (uri: string | null) => (uri ? {} : null),
    Skia: { Path: { MakeFromSVGString: () => ({ contains: () => true }) } },
  };
});
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useSharedValue: (value: number) => React.useRef({ value }).current,
    useDerivedValue: (value: () => unknown) => ({ value: value() }),
    withTiming: (value: number) => mockTiming(value),
  };
});
jest.mock('react-native-gesture-handler', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const chain = () => {
    const value = {
      onStart: () => value,
      onUpdate: () => value,
      onEnd: (callback: typeof mockTap) => {
        mockTap = callback;
        return value;
      },
      maxDistance: () => value,
      runOnJS: () => value,
    };
    return value;
  };
  return {
    GestureDetector: View,
    Gesture: {
      Pan: chain,
      Pinch: chain,
      Tap: chain,
      Race: chain,
      Simultaneous: chain,
    },
  };
});
const props = {
  board: artificialBoard,
  uris: { 'synthetic-piece': 'file:///private/artificial.jpg' },
  ownPieceId: 'synthetic-piece',
  animate: false,
  onAnimated: jest.fn(),
  notice: 'ローカル検証・実審査なし',
};
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

test('unavailable screenshot assets offer a readable error and a way back', async () => {
  const close = jest.fn();
  const screen = render(<DemoGallery photos={[]} onClose={close} />);
  await settle();
  expect(screen.getByText(/撮影用画像を読み込めませんでした/)).toBeTruthy();
  fireEvent.press(screen.getByText('戻る'));
  expect(close).toHaveBeenCalledTimes(1);
});

test('screenshot art opens the real board and piece photo and returns to the gallery list', async () => {
  const close = jest.fn();
  const gallery = demoGallerySource(
    Array.from({ length: 12 }, (_, index) => `file:///artificial-${index}.jpg`),
  );
  const screen = render(
    <Gallery gallery={gallery} online onClose={close} closeLabel="戻る" />,
  );
  await settle();
  fireEvent.press(screen.getByLabelText('2026年10月30日のパズル'));
  await settle();
  expect(screen.queryByText(/\d+ピース/)).toBeNull();
  act(() => mockTap?.({ x: 150, y: 150 }, true));
  const photo = screen.getByLabelText('ピースの写真').props.source as {
    uri: unknown;
  };
  expect(photo.uri).toMatch(/^file:\/\/\/artificial-/);
  expect(screen.queryByText('ローカル検証・実審査なし')).toBeNull();
  fireEvent.press(screen.getByLabelText('閉じる'));
  fireEvent.press(screen.getByText('一覧へ戻る'));
  expect(screen.getByText('2026年10月')).toBeTruthy();
  fireEvent.press(screen.getByText('戻る'));
  expect(close).toHaveBeenCalledTimes(1);
});

test('keeps signature/caption inside photo detail and shows the local notice in the modal', async () => {
  const screen = render(<Board {...props} />);
  await settle();
  expect(screen.queryByText('人工署名')).toBeNull();
  expect(screen.queryByText('人工図形')).toBeNull();
  fireEvent.press(screen.getByText('自分のピース'));
  expect(screen.getByLabelText('ピースの写真')).toBeTruthy();
  expect(screen.getByText('人工署名')).toBeTruthy();
  expect(screen.getByText('人工図形')).toBeTruthy();
  expect(screen.getByText('ローカル検証・実審査なし')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('閉じる'));
  expect(screen.queryByText('人工署名')).toBeNull();
});
test('a blanked or unavailable photo closes an already-open detail', async () => {
  const screen = render(<Board {...props} />);
  await settle();
  fireEvent.press(screen.getByText('自分のピース'));
  screen.rerender(
    <Board
      {...props}
      uris={{}}
      board={{
        ...artificialBoard,
        version: 2,
        pieces: artificialBoard.pieces.map((piece) => ({
          ...piece,
          visibility: 'blank',
          photoRef: null,
          username: null,
          caption: null,
        })),
      }}
    />,
  );
  expect(screen.queryByLabelText('ピースの写真')).toBeNull();
  expect(screen.queryByText('人工署名')).toBeNull();
});
test('respects Reduce Motion while consuming a new-piece animation once', async () => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
  render(<Board {...props} animate />);
  await settle();
  expect(mockTiming).not.toHaveBeenCalled();
  expect(props.onAnimated).toHaveBeenCalledTimes(1);
});
test('own photo deletion requires confirmation, supports cancel and sends only the piece ID', async () => {
  const remove = jest.fn(async () => {});
  const screen = render(<Board {...props} onDeleteOwnPhoto={remove} />);
  await settle();
  fireEvent.press(screen.getByText('自分のピース'));
  fireEvent.press(screen.getByText('写真を削除'));
  expect(remove).not.toHaveBeenCalled();
  expect(
    screen.getByText(/今日は撮り直しやFITができなくなります/),
  ).toBeTruthy();
  fireEvent.press(screen.getByText('キャンセル'));
  expect(screen.queryByText('削除する')).toBeNull();
  fireEvent.press(screen.getByText('写真を削除'));
  fireEvent.press(screen.getByText('削除する'));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith('synthetic-piece');
  expect(screen.queryByLabelText('ピースの写真')).toBeNull();
});
test('another piece has no own-photo deletion operation', async () => {
  const screen = render(
    <Board
      {...props}
      ownPieceId="another-piece"
      onDeleteOwnPhoto={async () => {}}
    />,
  );
  await settle();
  act(() => mockTap?.({ x: 0, y: 0 }, true));
  expect(screen.getByLabelText('ピースの写真')).toBeTruthy();
  expect(screen.queryByText('写真を削除')).toBeNull();
});
test('report has no default reason, cancel does not submit, and confirmation sends only the selected piece and reason', async () => {
  const report = jest.fn(async () => {});
  const screen = render(
    <Board {...props} ownPieceId="another-piece" onReportPhoto={report} />,
  );
  await settle();
  act(() => mockTap?.({ x: 0, y: 0 }, true));
  expect(screen.queryByText('この写真を通報する')).toBeNull();
  fireEvent.press(screen.getByText('通報・ブロック'));
  fireEvent.press(screen.getByText('この写真を通報する'));
  expect(
    screen
      .getAllByRole('radio')
      .every(
        (radio) =>
          !(radio.props.accessibilityState as { checked: boolean }).checked,
      ),
  ).toBe(true);
  fireEvent.press(screen.getByText('通報して非表示にする'));
  expect(report).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('キャンセル'));
  expect(report).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('この写真を通報する'));
  fireEvent.press(screen.getByLabelText('嫌がらせ・差別'));
  fireEvent.press(screen.getByText('通報して非表示にする'));
  expect(report).toHaveBeenCalledWith('synthetic-piece', 'harassment');
  expect(screen.queryByLabelText('ピースの写真')).toBeNull();
});
test('own photo has no reporting action', async () => {
  const screen = render(<Board {...props} onReportPhoto={async () => {}} />);
  await settle();
  fireEvent.press(screen.getByText('自分のピース'));
  expect(screen.queryByText('この写真を通報する')).toBeNull();
});
test('report form keeps actions outside scrolling reasons and omits the full photo', async () => {
  const screen = render(
    <Board
      {...props}
      ownPieceId="another-piece"
      onReportPhoto={async () => {}}
    />,
  );
  await settle();
  act(() => mockTap?.({ x: 0, y: 0 }, true));
  fireEvent.press(screen.getByText('通報・ブロック'));
  fireEvent.press(screen.getByText('この写真を通報する'));
  const content = within(screen.getByTestId('piece-detail-scroll'));
  const actions = within(screen.getByTestId('piece-detail-actions'));
  expect(content.getAllByRole('radio')).toHaveLength(5);
  expect(content.queryByText('通報して非表示にする')).toBeNull();
  expect(content.queryByText('キャンセル')).toBeNull();
  expect(screen.queryByLabelText('ピースの写真')).toBeNull();
  expect(
    actions.getByRole('button', { name: '通報して非表示にする' }).props
      .accessibilityState,
  ).toMatchObject({ disabled: true });
  expect(actions.getByText('キャンセル')).toBeTruthy();
  fireEvent.press(content.getByLabelText('その他'));
  expect(
    actions.getByRole('button', { name: '通報して非表示にする' }).props
      .accessibilityState,
  ).toMatchObject({ disabled: false });
});

test('safety block requires confirmation, cancel preserves the photo, and actions stay outside scrolling content', async () => {
  const block = jest.fn(async () => {});
  const screen = render(
    <Board {...props} ownPieceId="another-piece" onBlockPhoto={block} />,
  );
  await settle();
  act(() => mockTap?.({ x: 0, y: 0 }, true));
  fireEvent.press(screen.getByText('通報・ブロック'));
  fireEvent.press(screen.getByText('この相手を安全上ブロックする'));
  expect(block).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('ピースの写真')).toBeNull();
  const actions = within(screen.getByTestId('piece-detail-actions'));
  expect(actions.getByText('ブロックする')).toBeTruthy();
  expect(actions.getByText('キャンセル')).toBeTruthy();
  expect(
    within(screen.getByTestId('piece-detail-scroll')).queryByText(
      'ブロックする',
    ),
  ).toBeNull();
  fireEvent.press(actions.getByText('キャンセル'));
  expect(block).not.toHaveBeenCalled();
  expect(screen.getByLabelText('ピースの写真')).toBeTruthy();
  fireEvent.press(screen.getByText('この相手を安全上ブロックする'));
  fireEvent.press(screen.getByText('ブロックする'));
  expect(block).toHaveBeenCalledWith('synthetic-piece');
});

test('own photo never offers safety block', async () => {
  const screen = render(<Board {...props} onBlockPhoto={async () => {}} />);
  await settle();
  fireEvent.press(screen.getByText('自分のピース'));
  expect(screen.queryByText('この相手を安全上ブロックする')).toBeNull();
});

test('a piece without signature or caption shows neither placeholder', async () => {
  const bare = {
    ...artificialBoard,
    pieces: artificialBoard.pieces.map((piece) => ({
      ...piece,
      username: null,
      caption: null,
    })),
  };
  const screen = render(<Board {...props} board={bare} />);
  await settle();
  fireEvent.press(screen.getByText('自分のピース'));
  expect(screen.getByLabelText('ピースの写真')).toBeTruthy();
  expect(screen.queryByText('署名なし')).toBeNull();
  expect(screen.queryByText('キャプションなし')).toBeNull();
});
test('a viewed piece can be closed from the corner without exposing actions it cannot use', async () => {
  const screen = render(<Board {...props} />);
  await settle();
  fireEvent.press(screen.getByText('自分のピース'));
  expect(screen.queryByTestId('piece-detail-actions')).toBeNull();
  fireEvent.press(screen.getByLabelText('閉じる'));
  expect(screen.queryByLabelText('ピースの写真')).toBeNull();
});
test('the touch hint stays until the first tap', async () => {
  const screen = render(<Board {...props} ownPieceId="another-piece" />);
  await settle();
  expect(screen.getByText('写真に触れると大きく見られます')).toBeTruthy();
  act(() => mockTap?.({ x: 0, y: 0 }, true));
  expect(screen.queryByText('写真に触れると大きく見られます')).toBeNull();
});

test('the thumbnail reveals once and holds still when Reduce Motion is on', async () => {
  const thumb = { board: artificialBoard, uris: props.uris, size: 160 };
  render(<BoardThumbnail {...thumb} />);
  await settle();
  expect(mockTiming).not.toHaveBeenCalled();
  render(<BoardThumbnail {...thumb} reveal />);
  await settle();
  expect(mockTiming).toHaveBeenCalledTimes(1);
  mockTiming.mockClear();
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValue(true);
  render(<BoardThumbnail {...thumb} reveal />);
  await settle();
  expect(mockTiming).not.toHaveBeenCalled();
});

test('a filling board waits for its space, then draws at exactly that height', async () => {
  const screen = render(<Board {...props} fill />);
  await settle();
  expect(screen.queryByLabelText(/今日のパズル/)).toBeNull();
  fireEvent(screen.getByTestId('board-card'), 'layout', {
    nativeEvent: { layout: { width: 358, height: 431 } },
  });
  const canvas = screen.getByLabelText(/今日のパズル/);
  expect(canvas.props.style).toMatchObject({ height: 431 });
});
