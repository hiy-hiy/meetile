import type {
  Firestore,
  Transaction,
  DocumentSnapshot,
} from 'firebase-admin/firestore';
import { boardViewSchema, type BoardView } from '@puzzle-sns/contracts';
import { validateBoard } from '@puzzle-sns/puzzle-engine';
import { requireCondition } from '../domain/errors';
import {
  mediaAccessSchema,
  pieceSchema,
  subjectSchema,
  type CanonicalBoard,
  type MediaAccess,
  type PrivatePiece,
  type Subject,
} from '../domain/models';
import { paths } from '../repositories/paths';

export interface ProjectionState {
  pieces: ReadonlyMap<string, PrivatePiece>;
  subjects: ReadonlyMap<string, Subject>;
  media: ReadonlyMap<string, MediaAccess>;
  documents: ReadonlyMap<string, DocumentSnapshot>;
}
/** All reads precede writes. Pair checks stay private and are never returned as DTOs. */
export async function loadProjectionState(
  db: Firestore,
  tx: Transaction,
  board: CanonicalBoard,
  viewers = board.members.map((member) => member.uid),
): Promise<ProjectionState> {
  validateBoard(board.geometry);
  requireCondition(
    new Set(board.members.map((m) => m.uid)).size === board.members.length,
  );
  requireCondition(board.members.length === board.geometry.pieces.length);
  for (const member of board.members) {
    requireCondition(
      board.geometry.pieces.some((p) => p.id === member.pieceId),
    );
    requireCondition(
      board.geometry.participantKeys.includes(member.participantKey),
    );
  }
  requireCondition(
    new Set(board.members.map((m) => m.pieceId)).size === board.members.length,
  );
  requireCondition(
    new Set(board.members.map((m) => m.participantKey)).size ===
      board.members.length,
  );
  const required = new Set<string>();
  for (const member of board.members) {
    required.add(paths.piece(member.pieceId));
    required.add(paths.subject(member.uid));
    required.add(paths.media(member.pieceId));
    for (const viewer of viewers) {
      required.add(paths.hidden(viewer, member.pieceId));
      if (viewer !== member.uid) required.add(paths.block(viewer, member.uid));
    }
  }
  const snapshots = await tx.getAll(
    ...[...required].map((path) => db.doc(path)),
  );
  const documents = new Map(
    snapshots.map((snapshot) => [snapshot.ref.path, snapshot]),
  );
  const pieces = new Map<string, PrivatePiece>();
  const subjects = new Map<string, Subject>();
  const media = new Map<string, MediaAccess>();
  for (const member of board.members) {
    const piece = pieceSchema.parse(
      documents.get(paths.piece(member.pieceId))?.data(),
    );
    requireCondition(
      piece.ownerUid === member.uid && piece.dayKey === board.dayKey,
    );
    const geometry = board.geometry.pieces.find(
      (value) => value.id === member.pieceId,
    );
    requireCondition(geometry);
    for (const direction of ['north', 'east', 'south', 'west'] as const)
      requireCondition(piece.edges[direction] === geometry.edges[direction]);
    pieces.set(member.pieceId, piece);
    const subject = documents.get(paths.subject(member.uid));
    subjects.set(
      member.uid,
      subject?.exists
        ? subjectSchema.parse(subject.data())
        : { status: 'ended', accessEpoch: 0 },
    );
    const acl = documents.get(paths.media(member.pieceId));
    media.set(
      member.pieceId,
      acl?.exists
        ? mediaAccessSchema.parse(acl.data())
        : { visible: false, epochs: {} },
    );
  }
  return { pieces, subjects, media, documents };
}

export function projectionFor(
  boardId: string,
  board: CanonicalBoard,
  viewer: string,
  state: ProjectionState,
): BoardView {
  return boardViewSchema.parse({
    boardId,
    dayKey: board.dayKey,
    version: board.version,
    pieces: board.geometry.pieces.map((geometry) => {
      const piece = state.pieces.get(geometry.id);
      requireCondition(piece);
      const blank =
        piece.status !== 'approved' ||
        state.documents.get(paths.hidden(viewer, geometry.id))?.exists ===
          true ||
        (viewer !== piece.ownerUid &&
          state.documents.get(paths.block(viewer, piece.ownerUid))?.exists ===
            true);
      return {
        ...geometry,
        visibility: blank ? 'blank' : 'visible',
        photoRef: blank ? null : `normalized/${geometry.id}/image`,
        username: blank ? null : piece.username,
        caption: blank ? null : piece.caption,
      };
    }),
  });
}

export function writeProjections(
  db: Firestore,
  tx: Transaction,
  boardId: string,
  board: CanonicalBoard,
  state: ProjectionState,
  viewers = board.members.map((member) => member.uid),
): BoardView[] {
  const views = viewers.map((viewer) => {
    const subject = state.subjects.get(viewer);
    requireCondition(subject);
    const view = projectionFor(boardId, board, viewer, state);
    // D-06: an ended member's piece stays in the geometry, but other people's
    // later growth must not write fresh display copies into its deleted area.
    if (subject.status === 'ended') {
      tx.delete(db.doc(paths.view(viewer, boardId)));
      tx.delete(db.doc(paths.grant(viewer, boardId)));
      return view;
    }
    tx.set(db.doc(paths.view(viewer, boardId)), view);
    tx.set(db.doc(paths.grant(viewer, boardId)), {
      active: subject.status === 'active',
      accessEpoch: subject.accessEpoch,
    });
    return view;
  });
  for (const geometry of board.geometry.pieces) {
    const existing = state.media.get(geometry.id);
    const piece = state.pieces.get(geometry.id);
    requireCondition(existing && piece);
    const epochs: Record<string, number> = { ...existing.epochs };
    for (let index = 0; index < viewers.length; index++) {
      const viewer = viewers[index];
      requireCondition(viewer);
      const subject = state.subjects.get(viewer);
      requireCondition(subject);
      const visible =
        views[index]?.pieces.find((value) => value.id === geometry.id)
          ?.visibility === 'visible';
      if (visible && subject.status === 'active')
        epochs[viewer] = subject.accessEpoch;
      else delete epochs[viewer];
    }
    requireCondition(Object.keys(epochs).length <= 20);
    tx.set(db.doc(paths.media(geometry.id)), {
      visible: piece.status === 'approved',
      epochs,
    });
  }
  return views;
}
