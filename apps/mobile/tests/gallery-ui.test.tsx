import { fireEvent, render } from '@testing-library/react-native';
import { Text as MockText } from 'react-native';
import { Gallery } from '../src/components/gallery';
import type { GalleryController } from '../src/gallery/controller';
import { artificialBoard } from './fixtures/board';

jest.mock('../src/components/board', () => ({
  BoardThumbnail: (props: { uris: Record<string, string> }) => (
    <MockText>{`サムネイル:${Object.keys(props.uris).length}`}</MockText>
  ),
  Board: () => <MockText>詳細の盤面</MockText>,
}));
jest.mock('../src/components/share-board', () => ({
  ShareBoardButton: () => null,
}));

const entry = (boardId: string, dayKey: string, pieces = 1) => ({
  view: {
    ...artificialBoard,
    boardId,
    dayKey,
    pieces: Array.from({ length: pieces }, (_, index) => ({
      ...artificialBoard.pieces[0]!,
      id: `${boardId}-${index}`,
    })),
  },
  uris: { [`${boardId}-0`]: 'file:///private/artificial.jpg' },
});
const controller = (
  status: 'ready' | 'offline' | 'syncing',
  entries: ReturnType<typeof entry>[],
) => {
  const snapshot = { status, entries };
  return {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    load: jest.fn(async () => {}),
    sync: jest.fn(async () => {}),
  } as unknown as GalleryController;
};

test('days are grouped by month with their date, and no piece count is shown', () => {
  const screen = render(
    <Gallery
      gallery={controller('ready', [
        entry('a', '2026-10-30', 7),
        entry('b', '2026-10-29', 3),
        entry('c', '2026-09-30', 2),
      ])}
      online
      onClose={jest.fn()}
    />,
  );
  expect(screen.getByText('2026年10月')).toBeTruthy();
  expect(screen.getByText('2026年9月')).toBeTruthy();
  expect(screen.getByText('10月30日（金）')).toBeTruthy();
  expect(screen.getAllByText('サムネイル:1')).toHaveLength(3);
  expect(screen.queryByText(/ピース/)).toBeNull();
  fireEvent.press(screen.getByLabelText('2026年10月30日のパズル'));
  expect(screen.getByText('詳細の盤面')).toBeTruthy();
  expect(screen.getByText(/午前4時に確定した作品です/)).toBeTruthy();
  expect(screen.queryByText(/ピース/)).toBeNull();
});
test('an empty gallery invites the first day; the offline line shows only when it matters', () => {
  const empty = render(
    <Gallery gallery={controller('ready', [])} online onClose={jest.fn()} />,
  );
  expect(empty.getByText(/最初の作品は/)).toBeTruthy();
  expect(empty.queryByText(/オフライン/)).toBeNull();
  const offline = render(
    <Gallery
      gallery={controller('offline', [entry('a', '2026-10-30')])}
      online={false}
      onClose={jest.fn()}
    />,
  );
  expect(offline.getByText(/オフライン：この端末に保存/)).toBeTruthy();
  expect(offline.getByText(/復元できません/)).toBeTruthy();
});
