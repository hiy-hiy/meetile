import {
  DIRECTIONS,
  MAX_PIECES,
  gridPointSchema,
  seedSchema,
  type BoardGeometry,
  type GridPoint,
  type MergeFailureReason,
  type MergeResult,
  type Placement,
} from '@puzzle-sns/contracts';
import {
  SIDES,
  cellKey,
  cellsOf,
  neighbor,
  safeInteger,
  shifted,
  validateBoard,
} from './boards';
import { edgesFit } from './pieces';
import { createSeededRandom, randomIndex } from './random';

function eligibility(
  a: BoardGeometry,
  b: BoardGeometry,
): MergeFailureReason | undefined {
  const participants = new Set(a.participantKeys);
  if (b.participantKeys.some((key) => participants.has(key)))
    return 'duplicate-participants';
  const pieces = new Set(a.pieces.map((piece) => piece.id));
  if (b.pieces.some((piece) => pieces.has(piece.id))) return 'duplicate-pieces';
  if (a.pieces.length + b.pieces.length > MAX_PIECES) return 'piece-limit';
  return undefined;
}

function contactTranslations(
  a: BoardGeometry,
  b: BoardGeometry,
): readonly GridPoint[] {
  const aCells = cellsOf(a);
  const bCells = cellsOf(b);
  const candidates = new Map<string, GridPoint>();
  for (const aPiece of a.pieces) {
    for (const direction of DIRECTIONS) {
      const target = neighbor(aPiece.position, direction);
      if (aCells.has(cellKey(target))) continue;
      for (const bPiece of b.pieces) {
        if (
          bCells.has(
            cellKey(neighbor(bPiece.position, SIDES[direction].opposite)),
          )
        )
          continue;
        const translation = {
          x: safeInteger(target.x - bPiece.position.x),
          y: safeInteger(target.y - bPiece.position.y),
        };
        candidates.set(cellKey(translation), translation);
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.x - b.x || a.y - b.y);
}

function contactCount(
  a: BoardGeometry,
  b: BoardGeometry,
  translation: GridPoint,
): number | undefined {
  const aCells = cellsOf(a);
  const translated = b.pieces.map((piece) => ({
    ...piece,
    position: shifted(piece.position, translation),
  }));
  if (translated.some((piece) => aCells.has(cellKey(piece.position))))
    return undefined;
  let count = 0;
  for (const piece of translated) {
    for (const direction of DIRECTIONS) {
      const adjacent = aCells.get(cellKey(neighbor(piece.position, direction)));
      if (!adjacent) continue;
      if (
        !edgesFit(
          piece.edges[direction],
          adjacent.edges[SIDES[direction].opposite],
        )
      )
        return undefined;
      count++;
    }
  }
  return count > 0 ? count : undefined;
}

/** Includes overlapping and mismatched candidates; enumerates every possible new contact. */
export function enumerateContactTranslations(
  aInput: unknown,
  bInput: unknown,
): readonly GridPoint[] {
  return contactTranslations(validateBoard(aInput), validateBoard(bInput));
}

export function evaluatePlacement(
  aInput: unknown,
  bInput: unknown,
  translationInput: GridPoint,
): Placement | undefined {
  const a = validateBoard(aInput);
  const b = validateBoard(bInput);
  const translation = gridPointSchema.parse(translationInput);
  if (eligibility(a, b)) return undefined;
  const count = contactCount(a, b, translation);
  return count === undefined ? undefined : { translation, contactCount: count };
}

function validPlacements(
  a: BoardGeometry,
  b: BoardGeometry,
): readonly Placement[] {
  if (eligibility(a, b)) return [];
  const placements: Placement[] = [];
  for (const translation of contactTranslations(a, b)) {
    const count = contactCount(a, b, translation);
    if (count !== undefined)
      placements.push({ translation, contactCount: count });
  }
  return placements;
}

export function findValidPlacements(
  aInput: unknown,
  bInput: unknown,
): readonly Placement[] {
  return validPlacements(validateBoard(aInput), validateBoard(bInput));
}

function compareIdentifiers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stays fixed; B translates as one rigid board. No dates, eligibility state, or writes here. */
export function mergeBoards(
  aInput: unknown,
  bInput: unknown,
  seedInput: number,
): MergeResult {
  const a = validateBoard(aInput);
  const b = validateBoard(bInput);
  const seed = seedSchema.parse(seedInput);
  const failure = eligibility(a, b);
  if (failure) return { status: 'not-merged', reason: failure };
  const placements = validPlacements(a, b);
  if (placements.length === 0)
    return { status: 'not-merged', reason: 'no-placement' };
  const maxContacts = Math.max(
    ...placements.map((placement) => placement.contactCount),
  );
  const maximal = placements.filter(
    (placement) => placement.contactCount === maxContacts,
  );
  const selected =
    maximal[randomIndex(maximal.length, createSeededRandom(seed))];
  if (!selected) throw new RangeError('Missing selected placement');
  const pieces = [
    ...a.pieces,
    ...b.pieces.map((piece) => ({
      ...piece,
      position: shifted(piece.position, selected.translation),
    })),
  ].sort((a, b) => compareIdentifiers(a.id, b.id));
  return {
    status: 'merged',
    board: {
      pieces,
      participantKeys: [...a.participantKeys, ...b.participantKeys].sort(
        compareIdentifiers,
      ),
    },
    placement: selected,
    validCandidateCount: placements.length,
    maximalCandidateCount: maximal.length,
  };
}
