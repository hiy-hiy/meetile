import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  assertLocalServer,
} from '../tools/local-development/config.ts';
import {
  boardSchema,
  pieceSchema,
  dailySchema,
  subjectSchema,
} from '../apps/functions/dist/domain/models.js';
import { Backend } from '../apps/functions/dist/services/backend.js';
import { PhotoStorage } from '../apps/functions/dist/services/photo-storage.js';
import { mergeBoards } from '../packages/puzzle-engine/dist/index.js';

// Trusted artificial data only. This helper is not imported by either app or
// Functions entry, and it refuses every real project and remote emulator host.
export async function createReportFixture(
  db,
  bucket,
  ownerUid,
  targetUid,
  mode = 'report',
) {
  assert.ok(['report', 'block'].includes(mode));
  assertLocalServer({ ...process.env, FUNCTIONS_EMULATOR: 'true' });
  assert.equal(db.projectId, LOCAL_PROJECT);
  assert.equal(bucket.name, LOCAL_BUCKET);
  const backend = new Backend(db);
  const day = await backend.getDayState(ownerUid);
  assert.equal(
    day.photoState,
    'ready',
    'Create an artificial photo first; deleted pieces are never replaced.',
  );
  assert.ok(day.boardId && day.ownPieceId);
  assert.ok(ownerUid !== targetUid, 'Distinct fixture actors required');
  const pieceId = randomUUID();
  const key = randomUUID();
  const boardId = randomUUID();
  const photos = new PhotoStorage(bucket);
  const sharp = createRequire(
    new URL('../apps/functions/package.json', import.meta.url),
  )('sharp');
  const image = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: mode === 'block' ? '#956b9e' : '#297f9a',
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 480,
            height: 480,
            channels: 3,
            background: mode === 'block' ? '#b7e0a5' : '#f7cf68',
          },
        },
        left: 272,
        top: 272,
      },
    ])
    .jpeg({ quality: 80 })
    .toBuffer();
  await photos.save(`normalized/${pieceId}/image`, image);
  let committed = false;
  try {
    await db.runTransaction(async (tx) => {
      const dailyRef = db.doc(`days/${day.dayKey}/members/${ownerUid}`);
      const daily = dailySchema.parse((await tx.get(dailyRef)).data());
      const sourceRef = db.doc(`boards/${daily.boardId}`);
      const source = boardSchema.parse((await tx.get(sourceRef)).data());
      const piece = pieceSchema.parse(
        (await tx.get(db.doc(`pieces/${daily.pieceId}`))).data(),
      );
      const subject = subjectSchema.parse(
        (await tx.get(db.doc(`subjects/${ownerUid}`))).data(),
      );
      const targetDaily = await tx.get(
        db.doc(`days/${day.dayKey}/members/${targetUid}`),
      );
      assert.ok(!targetDaily.exists);
      assert.equal(source.status, 'active');
      assert.equal(
        source.members.length,
        mode === 'block' ? 2 : 1,
        'Unexpected artificial fixture board size',
      );
      assert.ok(
        source.members.some((member) => member.uid === ownerUid),
        'Fixture owner mismatch',
      );
      const previous = await Promise.all(
        source.members.map(async (member) => ({
          member,
          subject: subjectSchema.parse(
            (await tx.get(db.doc(`subjects/${member.uid}`))).data(),
          ),
          daily: dailySchema.parse(
            (
              await tx.get(db.doc(`days/${day.dayKey}/members/${member.uid}`))
            ).data(),
          ),
        })),
      );
      for (const entry of previous)
        assert.equal(entry.daily.boardId, daily.boardId);
      assert.equal(piece.status, 'approved');
      assert.equal(subject.status, 'active');
      const inverse = {
        'round-out': 'round-in',
        'round-in': 'round-out',
        'square-out': 'square-in',
        'square-in': 'square-out',
      };
      const boundary = source.geometry.pieces.reduce((best, value) =>
        value.position.y < best.position.y ? value : best,
      );
      const edges = {
        north: 'round-out',
        east: 'square-in',
        south: inverse[boundary.edges.north],
        west: 'round-in',
      };
      const geometry = { id: pieceId, position: { x: 0, y: 0 }, edges };
      const merged = mergeBoards(
        source.geometry,
        { pieces: [geometry], participantKeys: [key] },
        Number.parseInt(boardId.slice(0, 8), 16),
      );
      assert.equal(merged.status, 'merged');
      tx.create(db.doc(`pieces/${pieceId}`), {
        ownerUid: targetUid,
        dayKey: day.dayKey,
        edges,
        status: 'approved',
        username: mode === 'block' ? 'ブロックテスト用' : '通報テスト用',
        caption: 'Macで生成した人工図形です。',
      });
      tx.create(db.doc(`boards/${boardId}`), {
        dayKey: day.dayKey,
        version: source.version + 1,
        status: 'active',
        geometry: merged.board,
        members: [
          ...source.members,
          { uid: targetUid, pieceId, participantKey: key },
        ],
      });
      tx.update(sourceRef, { status: 'retired' });
      for (const entry of previous) {
        tx.update(db.doc(`days/${day.dayKey}/members/${entry.member.uid}`), {
          boardId,
        });
        tx.update(
          db.doc(`viewGrants/${entry.member.uid}/boards/${daily.boardId}`),
          { active: false },
        );
        tx.set(db.doc(`clientState/${entry.member.uid}`), {
          dayKey: day.dayKey,
          boardId,
          accessRevision: entry.subject.accessEpoch,
        });
      }
      tx.set(db.doc(`subjects/${targetUid}`), {
        status: 'active',
        accessEpoch: 0,
      });
      tx.create(db.doc(`days/${day.dayKey}/members/${targetUid}`), {
        dayKey: day.dayKey,
        boardId,
        pieceId,
        participantKey: key,
      });
      tx.set(db.doc(`mediaAccess/${pieceId}`), { visible: true, epochs: {} });
      tx.set(db.doc(`clientState/${targetUid}`), {
        dayKey: day.dayKey,
        boardId,
        accessRevision: 0,
      });
    });
    committed = true;
    const board = boardSchema.parse(
      (await db.doc(`boards/${boardId}`).get()).data(),
    );
    for (const member of board.members)
      await backend.syncBoardView(member.uid, boardId);
    return { pieceId, boardId, dayKey: day.dayKey };
  } catch (error) {
    if (!committed) await photos.remove(`normalized/${pieceId}/image`);
    throw error;
  }
}
