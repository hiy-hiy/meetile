import { Firestore } from 'firebase-admin/firestore';
import type { Edges } from '@puzzle-sns/contracts';
import { Backend } from '../../apps/functions/src/services/backend';
import { SafetyFoundation } from '../../apps/functions/src/services/safety';
import { paths } from '../../apps/functions/src/repositories/paths';
import { boardAt } from '../../packages/puzzle-engine/tests/helpers';

export const PROJECT = 'demo-puzzle-sns-development';
for (const variable of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
]) {
  if (!process.env[variable]?.startsWith('127.0.0.1:'))
    throw new Error(`Tests require local ${variable}; refusing live access`);
}
export const db = new Firestore({
  projectId: PROJECT,
  host: '127.0.0.1:8080',
  ssl: false,
});
export const DAY = '2026-10-10';
export const NOW = Date.parse('2026-10-10T03:00:00Z');
export const OUT: Edges = {
  north: 'round-out',
  east: 'round-out',
  south: 'round-out',
  west: 'round-out',
};
export const IN: Edges = {
  north: 'round-in',
  east: 'round-in',
  south: 'round-in',
  west: 'round-in',
};
export const backend = new Backend(db, () => NOW);
export const safety = new SafetyFoundation(db);
export async function reset(): Promise<void> {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error('Emulator reset failed');
}
export async function seedBoard(
  prefix: string,
  count = 1,
  outer: Edges = OUT,
  day = DAY,
  uids: readonly string[] = [],
) {
  const geometry = boardAt(
    Array.from({ length: count }, (_, x) => ({ x, y: 0 })),
    prefix,
    outer,
  );
  const members = geometry.pieces.map((piece, index) => ({
    uid: uids[index] ?? `${prefix}-user-${index}`,
    pieceId: piece.id,
    participantKey: geometry.participantKeys[index] ?? '',
  }));
  const boardId = `${prefix}-board`;
  const board = {
    dayKey: day,
    version: 1,
    status: 'active',
    geometry,
    members,
  };
  const batch = db.batch();
  batch.set(db.doc(paths.board(boardId)), board);
  for (const member of members) {
    const piece = geometry.pieces.find((value) => value.id === member.pieceId);
    if (!piece) throw new Error('Bad fixture');
    batch.set(db.doc(paths.subject(member.uid)), {
      status: 'active',
      accessEpoch: 0,
    });
    batch.set(db.doc(paths.clientState(member.uid)), {
      dayKey: day,
      boardId,
      accessRevision: 0,
    });
    batch.set(db.doc(paths.daily(day, member.uid)), {
      dayKey: day,
      boardId,
      pieceId: member.pieceId,
      participantKey: member.participantKey,
    });
    batch.set(db.doc(paths.piece(member.pieceId)), {
      ownerUid: member.uid,
      dayKey: day,
      edges: piece.edges,
      status: 'approved',
      username: 'Synthetic name',
      caption: 'Synthetic caption',
    });
    batch.set(db.doc(paths.media(member.pieceId)), {
      visible: true,
      epochs: Object.fromEntries(members.map((m) => [m.uid, 0])),
    });
    batch.set(db.doc(paths.grant(member.uid, boardId)), {
      active: true,
      accessEpoch: 0,
    });
    batch.set(db.doc(paths.view(member.uid, boardId)), {
      boardId,
      dayKey: day,
      version: 1,
      pieces: geometry.pieces.map((p) => ({
        ...p,
        visibility: 'visible',
        photoRef: `normalized/${p.id}/image`,
        username: 'Synthetic name',
        caption: 'Synthetic caption',
      })),
    });
  }
  await batch.commit();
  const first = members[0];
  if (!first) throw new Error('Empty fixture');
  return { boardId, members, uid: first.uid, pieceId: first.pieceId };
}
export async function session(id: string, first: string, second: string) {
  await backend.createVerifiedSession(id, [first, second], NOW + 30000);
}
