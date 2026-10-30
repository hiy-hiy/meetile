import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Capture } from '../src/components/capture';
const mockTake = jest.fn(async () => ({
  uri: 'file:///private/artificial-source.jpg',
  width: 300,
  height: 150,
}));
const mockDeleted: string[] = [];
const mockPermission = { granted: true, canAskAgain: true };
const mockResult = {
  uri: 'file:///private/artificial-square.jpg',
  base64: '/9j/2Q==',
};
const mockRendered = {
  saveAsync: jest.fn(async () => mockResult),
  release: jest.fn(),
};
const mockContext = {
  crop: jest.fn(),
  resize: jest.fn(),
  renderAsync: jest.fn(async () => mockRendered),
  release: jest.fn(),
};
jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    CameraView: React.forwardRef(({ facing }: { facing: string }, ref) => {
      React.useImperativeHandle(ref, () => ({ takePictureAsync: mockTake }));
      return React.createElement(View, {
        testID: 'camera',
        accessibilityLabel: facing,
      });
    }),
    useCameraPermissions: () => [mockPermission, jest.fn()],
  };
});
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: () => mockContext },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('expo-file-system', () => ({
  File: class {
    exists = true;
    private readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    delete() {
      mockDeleted.push(this.uri);
    }
  },
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockDeleted.length = 0;
  mockPermission.granted = true;
  mockPermission.canAskAgain = true;
  mockContext.crop.mockReturnValue(mockContext);
  mockContext.resize.mockReturnValue(mockContext);
  mockTake.mockResolvedValue({
    uri: 'file:///private/artificial-source.jpg',
    width: 300,
    height: 150,
  });
});
test('requires camera permission and offers settings after permanent denial', () => {
  mockPermission.granted = false;
  mockPermission.canAskAgain = false;
  const screen = render(<Capture username="" post={jest.fn()} />);
  expect(screen.getByText('端末の設定を開く')).toBeTruthy();
  expect(screen.queryByTestId('camera')).toBeNull();
});
test('one screen takes the caption and submits, and temporary photos are purged', async () => {
  const post = jest.fn(async () => {});
  const screen = render(<Capture username="人工署名" post={post} />);
  fireEvent.press(screen.getByLabelText('撮影する'));
  await waitFor(() =>
    expect(screen.getByLabelText('投稿する写真のプレビュー')).toBeTruthy(),
  );
  fireEvent.changeText(screen.getByLabelText('キャプション'), '人工文章');
  expect(mockContext.crop).toHaveBeenCalledWith({
    originX: 75,
    originY: 0,
    width: 150,
    height: 150,
  });
  expect(mockContext.resize).toHaveBeenCalledWith({
    width: 1024,
    height: 1024,
  });
  expect(screen.getByText('署名：人工署名')).toBeTruthy();
  expect(screen.getByText(/差し替えられません/)).toBeTruthy();
  expect(screen.getByText(/取り消せません/)).toBeTruthy();
  expect(screen.queryByText('投稿の最終確認')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('このピースで出す'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/9j/2Q==', '人工文章'),
  );
  screen.unmount();
  expect(mockDeleted).toEqual(
    expect.arrayContaining([
      'file:///private/artificial-source.jpg',
      'file:///private/artificial-square.jpg',
    ]),
  );
});
test('switches front/back, discards a retake and prevents overlong captions from submission', async () => {
  const post = jest.fn(async () => {});
  const screen = render(<Capture username="" post={post} />);
  expect(screen.getByLabelText('back')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('カメラを切り替える'));
  expect(screen.getByLabelText('front')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('撮影する'));
  await waitFor(() =>
    expect(screen.getByLabelText('投稿する写真のプレビュー')).toBeTruthy(),
  );
  fireEvent.press(screen.getByText('撮り直す'));
  expect(mockDeleted).toHaveLength(2);
  expect(screen.queryByLabelText('投稿する写真のプレビュー')).toBeNull();
  fireEvent.press(screen.getByLabelText('撮影する'));
  await waitFor(() =>
    expect(screen.getByLabelText('キャプション')).toBeTruthy(),
  );
  fireEvent.changeText(screen.getByLabelText('キャプション'), 'あ'.repeat(141));
  fireEvent.press(screen.getByText('このピースで出す'));
  expect(post).not.toHaveBeenCalled();
});
test('late camera completion after background/unmount removes its file instead of restoring preview', async () => {
  let complete:
    | ((value: { uri: string; width: number; height: number }) => void)
    | undefined;
  mockTake.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const screen = render(<Capture username="" post={jest.fn()} />);
  fireEvent.press(screen.getByLabelText('撮影する'));
  screen.unmount();
  await act(async () => {
    complete?.({
      uri: 'file:///private/artificial-late.jpg',
      width: 300,
      height: 150,
    });
    await Promise.resolve();
  });
  expect(mockDeleted).toContain('file:///private/artificial-late.jpg');
  expect(mockContext.renderAsync).not.toHaveBeenCalled();
});
