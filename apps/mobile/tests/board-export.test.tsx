import { act, fireEvent, render } from '@testing-library/react-native';
import type { BoardView } from '@puzzle-sns/contracts';
import {
  EXPORT_APP_NAME,
  exportLayout,
  renderBoardImage,
} from '../src/export/board-image';
import { ShareBoardButton } from '../src/components/share-board';

const mockTexts: string[] = [];
const mockLoaded: string[] = [];
const mockWrites: { uri: string; size: number }[] = [];
let mockSurfaceSize: [number, number] = [0, 0];
jest.mock('@shopify/react-native-skia', () => {
  const paint = () => ({
    setColor() {},
    setStyle() {},
    setStrokeWidth() {},
    setAntiAlias() {},
  });
  const canvas = {
    clear() {},
    save() {},
    restore() {},
    scale() {},
    translate() {},
    drawPath() {},
    clipPath() {},
    drawImageRect() {},
    drawText: (text: string) => mockTexts.push(text),
  };
  return {
    ClipOp: { Intersect: 1 },
    ImageFormat: { PNG: 4 },
    PaintStyle: { Stroke: 1 },
    matchFont: () => ({ measureText: () => ({ width: 10 }) }),
    Skia: {
      Color: (value: string) => value,
      Paint: paint,
      XYWHRect: (x: number, y: number, width: number, height: number) => ({
        x,
        y,
        width,
        height,
      }),
      Path: { MakeFromSVGString: () => ({}) },
      Data: {
        fromURI: async (uri: string) => {
          mockLoaded.push(uri);
          return uri;
        },
      },
      Image: {
        MakeImageFromEncoded: () => ({ width: () => 400, height: () => 300 }),
      },
      Surface: {
        Make: (width: number, height: number) => {
          mockSurfaceSize = [width, height];
          return {
            getCanvas: () => canvas,
            flush() {},
            makeImageSnapshot: () => ({
              encodeToBytes: () => new Uint8Array([137, 80, 78, 71]),
            }),
          };
        },
      },
    },
  };
});
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    uri: string;
    exists = false;
    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }
    create() {}
    delete() {}
  },
  File: class {
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    write(bytes: Uint8Array) {
      mockWrites.push({ uri: this.uri, size: bytes.length });
    }
  },
}));

const edges = {
  north: 'round-out',
  east: 'round-out',
  south: 'round-out',
  west: 'round-in',
} as const;
const board: BoardView = {
  boardId: 'board',
  dayKey: '2026-10-29',
  version: 2,
  pieces: [
    {
      id: 'shown',
      position: { x: 0, y: 0 },
      edges,
      visibility: 'visible',
      photoRef: 'normalized/shown/image',
      username: 'Synthetic name',
      caption: 'Synthetic caption',
    },
    {
      id: 'deleted',
      position: { x: 1, y: 0 },
      edges,
      visibility: 'blank',
      photoRef: null,
      username: null,
      caption: null,
    },
    {
      id: 'wide',
      position: { x: 2, y: 0 },
      edges,
      visibility: 'visible',
      photoRef: 'normalized/wide/image',
      username: 'Other name',
      caption: 'Other caption',
    },
  ],
};

beforeEach(() => {
  mockTexts.length = 0;
  mockLoaded.length = 0;
  mockWrites.length = 0;
});

test('the layout fits the long side to 2048 px and puts the text below the puzzle area', () => {
  const layout = exportLayout(board);
  expect(Math.max(layout.pixelWidth, layout.pixelHeight)).toBe(2048);
  expect(layout.pixelWidth).toBeGreaterThan(layout.pixelHeight);
  // Puzzle area ends at originY + (maxY + CELL + inset - minY offset): text is beyond it.
  expect(layout.textY).toBeGreaterThan(layout.originY + 118);
  const single = exportLayout({ pieces: [board.pieces[0]!] });
  expect(single.pixelHeight).toBe(2048);
});

test('the PNG contains only the app name, the date and visible photos', async () => {
  const file = await renderBoardImage(board, {
    shown: 'file:///gallery/shown.jpg',
    wide: 'file:///gallery/wide.jpg',
    // A stale URI for a now-blank piece must never be drawn.
    deleted: 'file:///gallery/deleted.jpg',
  });
  expect(mockSurfaceSize[0]).toBe(2048);
  expect(mockTexts).toEqual([EXPORT_APP_NAME, '2026.10.29']);
  expect(mockLoaded).toEqual([
    'file:///gallery/shown.jpg',
    'file:///gallery/wide.jpg',
  ]);
  expect(mockWrites).toEqual([
    { uri: 'file:///cache/board-export/puzzle-2026-10-29.png', size: 4 },
  ]);
  expect(file.uri).not.toMatch(/Synthetic|Other|shown|wide/);
});

test('the share button waits for every visible photo and reports a failure', async () => {
  const share = jest.fn().mockRejectedValueOnce(new Error('no share sheet'));
  const screen = render(
    <ShareBoardButton board={board} uris={{ shown: 'a' }} share={share} />,
  );
  const button = () => screen.getByRole('button', { name: '画像で保存・共有' });
  expect(
    (button().props.accessibilityState as { disabled: boolean }).disabled,
  ).toBe(true);
  screen.rerender(
    <ShareBoardButton
      board={board}
      uris={{ shown: 'a', wide: 'b' }}
      share={share}
    />,
  );
  expect(
    (button().props.accessibilityState as { disabled: boolean }).disabled,
  ).toBe(false);
  await act(async () => {
    fireEvent.press(button());
  });
  expect(share).toHaveBeenCalledWith(board, { shown: 'a', wide: 'b' });
  expect(screen.getByRole('alert')).toBeTruthy();
});
