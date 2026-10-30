import { fireEvent, render } from '@testing-library/react-native';
import { EndUse } from '../src/components/end-use';
import type { MobileController, Snapshot } from '../src/controller';
const base: Snapshot = {
  phase: 'today',
  day: null,
  board: null,
  capture: null,
  uris: {},
  message: '',
  username: '',
  reportState: 'idle',
  reportMessage: '',
  blockState: 'idle',
  blockMessage: '',
  endState: 'idle',
  endMessage: '',
};
function controller() {
  return {
    endUse: jest.fn(async () => {}),
    retryErase: jest.fn(async () => {}),
    dismissEndUse: jest.fn(),
  };
}
const view = (state: Partial<Snapshot>, c = controller()) => ({
  c,
  screen: render(
    <EndUse
      state={{ ...base, ...state }}
      controller={c as unknown as MobileController}
    />,
  ),
});
test('nothing is requested until the irreversible consequences are shown and confirmed', () => {
  const { c, screen } = view({});
  expect(screen.queryByText(/取り消しや復元はできません/)).toBeNull();
  fireEvent.press(screen.getByText('利用終了について確認する'));
  expect(c.endUse).not.toHaveBeenCalled();
  expect(screen.getByText(/取り消しや復元はできません/)).toBeTruthy();
  fireEvent.press(screen.getByText('利用を終了する（取り消せません）'));
  expect(c.endUse).toHaveBeenCalledWith(false);
});
test('cancel returns to the collapsed state without a request', () => {
  const { c, screen } = view({});
  fireEvent.press(screen.getByText('利用終了について確認する'));
  fireEvent.press(screen.getByText('キャンセル'));
  expect(c.endUse).not.toHaveBeenCalled();
  expect(c.dismissEndUse).toHaveBeenCalled();
  expect(screen.getByText('利用終了について確認する')).toBeTruthy();
});
test('sending state disables both actions', () => {
  const { c, screen } = view({
    endState: 'sending',
    endMessage: '利用終了を送信しています。',
  });
  fireEvent.press(screen.getByText('利用を終了する（取り消せません）'));
  fireEvent.press(screen.getByText('キャンセル'));
  expect(c.endUse).not.toHaveBeenCalled();
  expect(c.dismissEndUse).not.toHaveBeenCalled();
  expect(screen.getByText('利用終了を送信しています。')).toBeTruthy();
});
test('failure offers resend; unsent safety items need an explicit discard', () => {
  const failed = view({ endState: 'failed', endMessage: '失敗' });
  fireEvent.press(failed.screen.getByText('もう一度送信する'));
  expect(failed.c.endUse).toHaveBeenCalledWith(false);
  const unsent = view({ endState: 'unsent', endMessage: '未送信あり' });
  fireEvent.press(unsent.screen.getByText('未送信を破棄して利用を終了する'));
  expect(unsent.c.endUse).toHaveBeenCalledWith(true);
});
test('after acceptance only the result is shown, with erase retry on failure', () => {
  const done = view({
    phase: 'ended',
    endState: 'done',
    endMessage: '利用を終了しました。',
  });
  expect(done.screen.getByText('利用を終了しました。')).toBeTruthy();
  expect(done.screen.queryByText('もう一度消去する')).toBeNull();
  const failed = view({ phase: 'ended', endState: 'erase-failed' });
  fireEvent.press(failed.screen.getByText('もう一度消去する'));
  expect(failed.c.retryErase).toHaveBeenCalled();
});
