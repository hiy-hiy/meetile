import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, Image, ScrollView, type AppStateStatus } from 'react-native';
import type { MobilePort, OwnPreferences } from '../src/controller';
import Connection from '../src/local/connection';
import { artificialBoard } from './fixtures/board';
const mockBoard = jest.fn<
  void,
  [{ uris: Record<string, string>; animate: boolean }]
>();
const mockRelease = jest.fn();
const mockDemoPhotos: number[] = [];
jest.mock('@puzzle-sns/gallery-demo-assets', () => ({
  get demoPhotos() {
    return mockDemoPhotos;
  },
}));
const mockDay = {
  dayKey: '2026-10-28',
  serverTimeMs: 1793145600000,
  ownPieceId: null,
  boardId: null,
  photoState: 'not-created',
};
const mockCapture = {
  captureId: 'synthetic-session',
  dayKey: mockDay.dayKey,
  status: 'open',
  uploadPath: 'pending/synthetic-session/image',
  boardId: null,
  username: null,
  caption: null,
};
let mockPreferences: OwnPreferences;
let mockPublished = false;
const mockPort: MobilePort = {
  initialize: jest.fn(async () => mockPreferences),
  eraseOwnData: jest.fn(async () => {}),
  savePreferences: jest.fn(async () => {}),
  call: jest.fn(async (name) =>
    name === 'getDayState'
      ? mockPublished
        ? {
            ...mockDay,
            photoState: 'ready',
            ownPieceId: 'synthetic-piece',
            boardId: 'synthetic-board',
          }
        : mockDay
      : name === 'syncBoardView'
        ? artificialBoard
        : name === 'acceptOnboarding'
          ? null
          : name === 'submitCapture'
            ? ((mockPublished = true),
              {
                ...mockCapture,
                status: 'approved',
                boardId: 'synthetic-board',
              })
            : mockCapture,
  ),
  subscribeState: () => () => {},
  subscribeBoard: () => () => {},
  loadImages: jest.fn(async () => ({
    uris: { 'synthetic-piece': 'file:///private/artificial.jpg' },
    release: mockRelease,
  })),
  checkConnection: jest.fn(async () => {}),
};
const defaultCall = jest.mocked(mockPort.call).getMockImplementation()!;
const defaultLoadImages = jest
  .mocked(mockPort.loadImages)
  .getMockImplementation()!;
let mockBackground: ((state: AppStateStatus) => void) | undefined;
jest.mock('../src/local/native-port', () => ({
  localPort: () => mockPort,
  LOCAL_GALLERY: 'local-gallery',
}));
// Export and notification modules load native Skia/notification code; they are covered separately.
jest.mock('../src/export/board-image', () => ({ shareBoardImage: jest.fn() }));
jest.mock('../src/notifications/scheduler', () => ({
  applyReminders: jest.fn(async () => {}),
  notificationPermission: jest.fn(async () => 'unavailable'),
  requestNotificationPermission: jest.fn(async () => 'unavailable'),
}));
jest.mock('../src/components/board', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    BoardThumbnail: () =>
      React.createElement(Text, null, '人工素材のサムネイル'),
    Board: (props: {
      uris: Record<string, string>;
      animate: boolean;
      onDeleteOwnPhoto?: (id: string) => Promise<void>;
    }) => {
      mockBoard(props);
      return React.createElement(
        jest.requireActual<typeof import('react-native')>('react-native').View,
        null,
        React.createElement(
          Text,
          null,
          props.uris['synthetic-piece'] ? '人工画像のピース' : '写真のない盤面',
        ),
        props.onDeleteOwnPhoto &&
          React.createElement(
            jest.requireActual<typeof import('react-native')>('react-native')
              .Pressable,
            {
              onPress: () => {
                void props.onDeleteOwnPhoto?.('synthetic-piece');
              },
            },
            React.createElement(Text, null, '人工画像を削除'),
          ),
      );
    },
  };
});
jest.mock('../src/components/capture', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Capture: ({
      post,
    }: {
      post: (base64: string, caption: string) => Promise<void>;
    }) =>
      React.createElement(
        Pressable,
        {
          onPress: () => {
            void post('/9j/2Q==', '人工図形');
          },
        },
        React.createElement(Text, null, '人工画像を送信'),
      ),
  };
});
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (listener: (state: unknown) => void) => {
      listener({ isConnected: true, isInternetReachable: false });
      return jest.fn();
    },
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView:
    jest.requireActual<typeof import('react-native')>('react-native').View,
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockDemoPhotos.length = 0;
  jest.mocked(mockPort.call).mockImplementation(defaultCall);
  jest.mocked(mockPort.loadImages).mockImplementation(defaultLoadImages);
  mockPublished = false;
  mockPreferences = {
    username: '',
    legalVersion: null,
    captureId: null,
    draft: null,
  };
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, listener) => {
      mockBackground = listener;
      return { remove: jest.fn() };
    });
});
test('private screenshot gallery opens before connection without initializing or calling the server', async () => {
  mockDemoPhotos.push(...Array.from({ length: 12 }, (_, i) => i + 1));
  jest.spyOn(Image, 'resolveAssetSource').mockImplementation((id) => ({
    uri: `file:///artificial-${typeof id === 'number' ? id : 0}.jpg`,
    width: 1,
    height: 1,
    scale: 1,
  }));
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('撮影用ギャラリー'));
  await waitFor(() => expect(screen.getByText('2026年10月')).toBeTruthy());
  expect(screen.getAllByText('人工素材のサムネイル')).toHaveLength(6);
  expect(screen.queryByText('ローカル検証・実審査なし')).toBeNull();
  expect(screen.queryByText(/オフライン/)).toBeNull();
  expect(mockPort.initialize).not.toHaveBeenCalled();
  expect(mockPort.call).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('戻る'));
  expect(screen.getByText('Macに接続して準備する')).toBeTruthy();
});
test('a failed normal connection still offers the independent screenshot gallery', async () => {
  mockDemoPhotos.push(...Array.from({ length: 12 }, (_, i) => i + 1));
  jest.spyOn(Image, 'resolveAssetSource').mockReturnValue({
    uri: 'file:///artificial.jpg',
    width: 1,
    height: 1,
    scale: 1,
  });
  jest
    .mocked(mockPort.initialize)
    .mockRejectedValueOnce(new Error('Mac stopped'));
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() => expect(screen.getByText('接続をやり直す')).toBeTruthy());
  fireEvent.press(screen.getByText('撮影用ギャラリー'));
  await waitFor(() => expect(screen.getByText('2026年10月')).toBeTruthy());
  expect(mockPort.call).not.toHaveBeenCalled();
});
afterEach(() => jest.restoreAllMocks());
async function onboarding() {
  const screen = render(<Connection />);
  expect(screen.getByRole('image', { name: 'Meetile' })).toBeTruthy();
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() =>
    expect(screen.getByText('内部検証を始める前に')).toBeTruthy(),
  );
  return screen;
}
test('LAN works without internet, acknowledgement stays distinct from formal consent, and age choices have no default', async () => {
  const screen = await onboarding();
  expect(screen.getByText(/正式な利用規約への同意ではありません/)).toBeTruthy();
  fireEvent.press(screen.getByText('内部検証を始める'));
  expect(mockPort.call).not.toHaveBeenCalledWith(
    'acceptOnboarding',
    expect.anything(),
  );
  fireEvent.press(screen.getByText('16歳未満'));
  fireEvent.press(screen.getByRole('checkbox'));
  fireEvent.press(screen.getByText('内部検証を始める'));
  expect(screen.getByText('このアプリは16歳以上の方が対象です。')).toBeTruthy();
  expect(mockPort.call).not.toHaveBeenCalledWith(
    'acceptOnboarding',
    expect.anything(),
  );
  fireEvent.press(screen.getByText('16歳以上'));
  fireEvent.press(screen.getByText('内部検証を始める'));
  await waitFor(() =>
    expect(screen.getByText('匿名認証で撮影準備ができました。')).toBeTruthy(),
  );
  expect(mockPort.call).toHaveBeenCalledWith('acceptOnboarding', {
    age16OrOlder: true,
    accepted: true,
    legalVersion: 'local-test-v1',
  });
  expect(mockPort.call).toHaveBeenCalledWith('beginCapture', {});
  expect(mockPort.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ username: '', legalVersion: 'local-test-v1' }),
  );
});
test('validates and normalizes the optional signature before starting', async () => {
  const screen = await onboarding();
  fireEvent.press(screen.getByText('16歳以上'));
  fireEvent.press(screen.getByRole('checkbox'));
  fireEvent.changeText(screen.getByLabelText('署名'), 'あ'.repeat(21));
  fireEvent.press(screen.getByText('内部検証を始める'));
  expect(mockPort.call).not.toHaveBeenCalledWith(
    'acceptOnboarding',
    expect.anything(),
  );
  fireEvent.changeText(screen.getByLabelText('署名'), ' 人工署名 ');
  fireEvent.press(screen.getByText('内部検証を始める'));
  await waitFor(() =>
    expect(screen.getByText('匿名認証で撮影準備ができました。')).toBeTruthy(),
  );
  expect(mockPort.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ username: '人工署名' }),
  );
});
test('restores acknowledged state and hides readiness while backgrounded', async () => {
  mockPreferences.legalVersion = 'local-test-v1';
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() =>
    expect(screen.getByText('匿名認証で撮影準備ができました。')).toBeTruthy(),
  );
  expect(screen.queryByText('内部検証を始める前に')).toBeNull();
  act(() => mockBackground?.('background'));
  expect(screen.queryByText('匿名認証で撮影準備ができました。')).toBeNull();
  act(() => mockBackground?.('active'));
  await waitFor(() =>
    expect(screen.getByText('匿名認証で撮影準備ができました。')).toBeTruthy(),
  );
});
test('failed initialization offers a retry without starting capture', async () => {
  jest
    .mocked(mockPort.initialize)
    .mockRejectedValueOnce(new Error('Mac stopped'));
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() => expect(screen.getByText('接続をやり直す')).toBeTruthy());
  expect(mockPort.call).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('接続をやり直す'));
  await waitFor(() =>
    expect(screen.getByText('内部検証を始める前に')).toBeTruthy(),
  );
});
test('fresh approval loads the board and photo, animates once, and restores without recapture/replay', async () => {
  mockPreferences.legalVersion = 'local-test-v1';
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() => expect(screen.getByText('人工画像を送信')).toBeTruthy());
  fireEvent.press(screen.getByText('人工画像を送信'));
  await waitFor(() =>
    expect(screen.getByText('人工画像のピース')).toBeTruthy(),
  );
  // Today is one fixed screen: nothing on it scrolls.
  expect(screen.UNSAFE_queryAllByType(ScrollView)).toHaveLength(0);
  expect(mockPort.call).toHaveBeenCalledWith('uploadCapture', {
    captureId: 'synthetic-session',
    base64: '/9j/2Q==',
  });
  expect(mockPort.call).toHaveBeenCalledWith('submitCapture', {
    captureId: 'synthetic-session',
    username: '',
    caption: '人工図形',
  });
  expect(mockPort.call).toHaveBeenCalledWith('syncBoardView', {
    boardId: 'synthetic-board',
  });
  expect(mockPort.loadImages).toHaveBeenCalledWith(artificialBoard);
  expect(mockBoard.mock.calls.some(([props]) => props.animate)).toBe(true);
  screen.unmount();
  expect(mockRelease).toHaveBeenCalled();
  mockBoard.mockClear();
  const restored = render(<Connection />);
  fireEvent.press(restored.getByText('Macに接続して準備する'));
  await waitFor(() =>
    expect(restored.getByText('人工画像のピース')).toBeTruthy(),
  );
  expect(restored.queryByText('人工画像を送信')).toBeNull();
  expect(mockBoard.mock.calls.every(([props]) => !props.animate)).toBe(true);
  act(() => mockBackground?.('background'));
  expect(restored.queryByText('人工画像のピース')).toBeNull();
  act(() => mockBackground?.('active'));
  await waitFor(() =>
    expect(restored.getByText('人工画像のピース')).toBeTruthy(),
  );
});
test('failed authenticated image retrieval hides the board and offers reconnection', async () => {
  mockPreferences.legalVersion = 'local-test-v1';
  mockPublished = true;
  jest
    .mocked(mockPort.loadImages)
    .mockRejectedValueOnce(new Error('access denied'));
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() => expect(screen.getByText('接続をやり直す')).toBeTruthy());
  expect(screen.queryByText('人工画像のピース')).toBeNull();
  fireEvent.press(screen.getByText('接続をやり直す'));
  await waitFor(() =>
    expect(screen.getByText('人工画像のピース')).toBeTruthy(),
  );
});

test('watchdog detects a stopped Mac, removes photos, and the reconnect button works in the same process', async () => {
  jest.useFakeTimers();
  try {
    mockPreferences.legalVersion = 'local-test-v1';
    mockPublished = true;
    const screen = render(<Connection />);
    fireEvent.press(screen.getByText('Macに接続して準備する'));
    await waitFor(() =>
      expect(screen.getByText('人工画像のピース')).toBeTruthy(),
    );
    jest
      .mocked(mockPort.checkConnection!)
      .mockRejectedValueOnce(new Error('Mac stopped'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText('人工画像のピース')).toBeNull();
    expect(mockRelease).toHaveBeenCalled();
    fireEvent.press(screen.getByText('接続をやり直す'));
    await waitFor(() =>
      expect(screen.getByText('人工画像のピース')).toBeTruthy(),
    );
    screen.unmount();
  } finally {
    jest.useRealTimers();
  }
});

test.each(['rejected', 'held', 'error'] as const)(
  '%s is unpublished and offers the correct next action',
  async (outcome) => {
    mockPreferences.legalVersion = 'local-test-v1';
    let status: string = 'open';
    let submissions = 0;
    jest.mocked(mockPort.call).mockImplementation(async (name) => {
      if (name === 'submitCapture') {
        submissions++;
        status = submissions === 1 ? outcome : 'approved';
        mockPublished = status === 'approved';
        return { ...mockCapture, status, username: '', caption: '人工図形' };
      }
      if (name === 'getCapture') return { ...mockCapture, status };
      if (name === 'beginCapture') {
        status = 'open';
        return { ...mockCapture, captureId: `retake-${submissions}` };
      }
      return defaultCall(name, {});
    });
    const screen = render(<Connection />);
    fireEvent.press(screen.getByText('Macに接続して準備する'));
    await waitFor(() =>
      expect(screen.getByText('人工画像を送信')).toBeTruthy(),
    );
    fireEvent.press(screen.getByText('人工画像を送信'));
    const message =
      outcome === 'rejected'
        ? 'この写真や文章は投稿できません。撮り直してください。'
        : outcome === 'held'
          ? '確認中です。公開せず、確認が終わるまでお待ちください。'
          : '確認を続けられませんでした。時間をおいて、もう一度お試しください。';
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(screen.queryByText('人工画像のピース')).toBeNull();
    expect(mockPort.loadImages).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByText(
        outcome === 'rejected' ? '撮り直す' : 'もう一度確認する',
      ),
    );
    if (outcome === 'rejected') {
      await waitFor(() =>
        expect(screen.getByText('人工画像を送信')).toBeTruthy(),
      );
      expect(submissions).toBe(1);
    } else if (outcome === 'held') {
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      expect(submissions).toBe(1);
      expect(mockPort.loadImages).not.toHaveBeenCalled();
    } else {
      await waitFor(() =>
        expect(screen.getByText('人工画像のピース')).toBeTruthy(),
      );
      expect(submissions).toBe(2);
    }
  },
);

test('reset detected on foreground returns to internal acknowledgement and removes the old photo', async () => {
  mockPreferences.legalVersion = 'local-test-v1';
  mockPublished = true;
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() =>
    expect(screen.getByText('人工画像のピース')).toBeTruthy(),
  );
  act(() => mockBackground?.('background'));
  mockPublished = false;
  mockPreferences = {
    username: '',
    legalVersion: null,
    captureId: null,
    draft: null,
  };
  act(() => mockBackground?.('active'));
  await waitFor(() =>
    expect(screen.getByText('内部検証を始める前に')).toBeTruthy(),
  );
  expect(screen.queryByText('人工画像のピース')).toBeNull();
});
test('local Today deletes through the controller and remains a blank board without a recapture action', async () => {
  mockPreferences.legalVersion = 'local-test-v1';
  mockPublished = true;
  let deleted = false;
  jest.mocked(mockPort.call).mockImplementation(async (name, data) => {
    if (name === 'deleteOwnPhoto') {
      deleted = true;
      return { status: 'deleted' };
    }
    if (deleted && name === 'getDayState')
      return {
        ...mockDay,
        ownPieceId: 'synthetic-piece',
        boardId: 'synthetic-board',
        photoState: 'unavailable',
      };
    if (deleted && name === 'syncBoardView')
      return {
        ...artificialBoard,
        pieces: artificialBoard.pieces.map((piece) => ({
          ...piece,
          visibility: 'blank',
          photoRef: null,
          username: null,
          caption: null,
        })),
      };
    return defaultCall(name, data);
  });
  jest.mocked(mockPort.loadImages).mockImplementation(async (view) => ({
    uris:
      view.pieces[0]?.visibility === 'visible'
        ? { 'synthetic-piece': 'file:///private/artificial.jpg' }
        : {},
    release: mockRelease,
  }));
  const screen = render(<Connection />);
  fireEvent.press(screen.getByText('Macに接続して準備する'));
  await waitFor(() =>
    expect(screen.getByText('人工画像のピース')).toBeTruthy(),
  );
  fireEvent.press(screen.getByText('人工画像を削除'));
  await waitFor(() =>
    expect(
      screen.getByText(
        '今日の写真は削除されています。次の日にまた撮影できます。',
      ),
    ).toBeTruthy(),
  );
  expect(screen.getByText('写真のない盤面')).toBeTruthy();
  expect(screen.queryByText('人工画像のピース')).toBeNull();
  expect(screen.queryByText('人工画像を送信')).toBeNull();
  expect(mockPort.call).toHaveBeenCalledWith('deleteOwnPhoto', {
    pieceId: 'synthetic-piece',
  });
});
