import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  ClipOp,
  ImageFormat,
  matchFont,
  PaintStyle,
  Skia,
  type SkImage,
} from '@shopify/react-native-skia';
import { CELL, colors, piecePath } from '@puzzle-sns/design';
import type { BoardView } from '@puzzle-sns/contracts';
import { hasNativeModule } from '../native-available';

/** G-MEDIA (2026-10-30): exported images are at most 2048 px on the long side, PNG. */
export const EXPORT_LONG_SIDE = 2048;
export const EXPORT_APP_NAME = 'Meetile';
const IMAGE_INSET = 18;
const IMAGE_SIZE = 136;

/**
 * Pure layout in board units: the puzzle area, a margin, and a footer band below the puzzle
 * for the app name and date. Nothing else (no signature, caption or identifier) is laid out.
 */
export function exportLayout(
  board: Pick<BoardView, 'pieces'>,
  longSide = EXPORT_LONG_SIDE,
) {
  const xs = board.pieces.map((p) => p.position.x * CELL);
  const ys = board.pieces.map((p) => p.position.y * CELL);
  const minX = Math.min(...xs) - IMAGE_INSET;
  const minY = Math.min(...ys) - IMAGE_INSET;
  const width = Math.max(...xs) + CELL + IMAGE_INSET - minX;
  const height = Math.max(...ys) + CELL + IMAGE_INSET - minY;
  const margin = Math.max(width, height) * 0.08;
  const footer = Math.max(width, height) * 0.08;
  const units = {
    width: width + margin * 2,
    height: height + margin * 2 + footer,
  };
  const scale = longSide / Math.max(units.width, units.height);
  return {
    scale,
    pixelWidth: Math.round(units.width * scale),
    pixelHeight: Math.round(units.height * scale),
    /** Board origin in board units after the margin. */
    originX: margin - minX,
    originY: margin - minY,
    /** Baseline of the footer text, below the puzzle area. */
    textY: margin + height + footer * 0.75,
    textX: margin,
    rightX: units.width - margin,
    fontSize: footer * 0.4,
  };
}

const dateText = (dayKey: string) => dayKey.replaceAll('-', '.');
const cover = (image: SkImage) => {
  const side = Math.min(image.width(), image.height());
  return Skia.XYWHRect(
    (image.width() - side) / 2,
    (image.height() - side) / 2,
    side,
    side,
  );
};

/**
 * Draws the board as currently shown (blanked pieces stay blank) into a PNG under the cache.
 * Only visible pieces with a local image are drawn with a photo.
 */
export async function renderBoardImage(
  board: BoardView,
  uris: Record<string, string>,
): Promise<File> {
  const layout = exportLayout(board);
  const surface = Skia.Surface.Make(layout.pixelWidth, layout.pixelHeight);
  if (!surface) throw new Error('Export surface unavailable');
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color(colors.bg));
  canvas.save();
  canvas.scale(layout.scale, layout.scale);
  const fill = Skia.Paint();
  fill.setColor(Skia.Color(colors.blank));
  const stroke = Skia.Paint();
  stroke.setColor(Skia.Color(colors.cut));
  stroke.setStyle(PaintStyle.Stroke);
  stroke.setStrokeWidth(2.5);
  stroke.setAntiAlias(true);
  const imagePaint = Skia.Paint();
  for (const piece of board.pieces) {
    const path = Skia.Path.MakeFromSVGString(piecePath(piece.edges));
    if (!path) continue;
    canvas.save();
    canvas.translate(
      layout.originX + piece.position.x * CELL,
      layout.originY + piece.position.y * CELL,
    );
    canvas.drawPath(path, fill);
    const uri = piece.visibility === 'visible' ? uris[piece.id] : undefined;
    if (uri) {
      const image = Skia.Image.MakeImageFromEncoded(
        await Skia.Data.fromURI(uri),
      );
      if (image) {
        canvas.save();
        canvas.clipPath(path, ClipOp.Intersect, true);
        canvas.drawImageRect(
          image,
          cover(image),
          Skia.XYWHRect(-IMAGE_INSET, -IMAGE_INSET, IMAGE_SIZE, IMAGE_SIZE),
          imagePaint,
        );
        canvas.restore();
      }
    }
    canvas.drawPath(path, stroke);
    canvas.restore();
  }
  // An explicit system family: without one, Android resolved no typeface and drew no text.
  const font = matchFont({
    fontFamily: Platform.select({ ios: 'Helvetica', default: 'sans-serif' }),
    fontSize: layout.fontSize,
  });
  const text = Skia.Paint();
  text.setColor(Skia.Color(colors.muted));
  canvas.drawText(EXPORT_APP_NAME, layout.textX, layout.textY, text, font);
  const date = dateText(board.dayKey);
  canvas.drawText(
    date,
    layout.rightX - font.measureText(date).width,
    layout.textY,
    text,
    font,
  );
  canvas.restore();
  surface.flush();
  const png = surface.makeImageSnapshot().encodeToBytes(ImageFormat.PNG, 100);
  // One file at a time: the previous export is removed before the next one is written.
  const directory = new Directory(Paths.cache, 'board-export');
  if (directory.exists) directory.delete();
  directory.create({ intermediates: true });
  const file = new File(directory, `puzzle-${board.dayKey}.png`);
  file.write(png);
  return file;
}

/** Opens the OS share sheet, which also offers saving the image to the device. */
export async function shareBoardImage(
  board: BoardView,
  uris: Record<string, string>,
): Promise<void> {
  // Loaded lazily: an older development binary without the native module keeps working.
  if (!hasNativeModule('ExpoSharing'))
    throw new Error('Sharing unavailable in this build');
  const Sharing = await import('expo-sharing');
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('Sharing unavailable');
  const file = await renderBoardImage(board, uris);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'image/png',
    UTI: 'public.png',
    dialogTitle: 'パズルを保存・共有',
  });
}
