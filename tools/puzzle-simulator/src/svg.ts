import {
  DIRECTIONS,
  type BoardGeometry,
  type EdgeKind,
  type GridPoint,
  type PieceGeometry,
} from '@puzzle-sns/contracts';
import { validateBoard } from '@puzzle-sns/puzzle-engine';

const CELL = 64;
const PADDING = 24;
const COLORS = ['#87b9ad', '#e8bc72', '#b4acd9', '#d9919b', '#83acd2'];

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[char] ?? char;
  });
}

function edgePath(
  start: GridPoint,
  dx: number,
  dy: number,
  kind: EdgeKind,
): string {
  const depth = kind.endsWith('-out') ? 0.18 : -0.18;
  const point = (along: number, outward = 0): string => {
    const x = start.x + dx * along + dy * outward;
    const y = start.y + dy * along - dx * outward;
    return `${(x * CELL).toFixed(3)} ${(y * CELL).toFixed(3)}`;
  };
  const tab = kind.startsWith('round-')
    ? `C ${point(0.35, depth)} ${point(0.65, depth)} ${point(0.65)}`
    : `L ${point(0.35, depth)} L ${point(0.65, depth)} L ${point(0.65)}`;
  return `L ${point(0.35)} ${tab} L ${point(1)}`;
}

function piecePath(piece: PieceGeometry): string {
  const starts = [
    { x: 0, y: 0, dx: 1, dy: 0 },
    { x: 1, y: 0, dx: 0, dy: 1 },
    { x: 1, y: 1, dx: -1, dy: 0 },
    { x: 0, y: 1, dx: 0, dy: -1 },
  ];
  const sides = DIRECTIONS.map((direction, index) => {
    const start = starts[index];
    if (!start) throw new Error('Missing drawing side');
    return edgePath(start, start.dx, start.dy, piece.edges[direction]);
  });
  return `M 0 0 ${sides.join(' ')} Z`;
}

/** Illustrative tab proportions, not the final Skia design or physical interference proof. */
export function renderBoardsSvg(input: readonly BoardGeometry[]): string {
  const boards = input.map(validateBoard);
  if (boards.length === 0)
    throw new RangeError('At least one board is required');
  let offset = 0;
  let height = 0;
  const groups = boards.map((board, boardIndex) => {
    const minX = Math.min(...board.pieces.map((piece) => piece.position.x));
    const minY = Math.min(...board.pieces.map((piece) => piece.position.y));
    const width =
      (Math.max(...board.pieces.map((piece) => piece.position.x)) - minX + 1) *
        CELL +
      PADDING * 2;
    const boardHeight =
      (Math.max(...board.pieces.map((piece) => piece.position.y)) - minY + 1) *
        CELL +
      PADDING * 2;
    height = Math.max(height, boardHeight);
    const paths = board.pieces.map((piece, index) => {
      const x = offset + PADDING + (piece.position.x - minX) * CELL;
      const y = PADDING + (piece.position.y - minY) * CELL;
      return `<path data-piece-id="${escapeXml(piece.id)}" transform="translate(${x} ${y})" d="${piecePath(piece)}" fill="${COLORS[index % COLORS.length]}" stroke="#24343b" stroke-width="1.5"/>`;
    });
    offset += width;
    return `<g id="board-${boardIndex}">${paths.join('')}</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${offset} ${height}" role="img"><title>Synthetic puzzle geometry simulation</title>${groups.join('')}</svg>\n`;
}
