import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URLSearchParams } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  LOCAL_PORTS,
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  LOCAL_REGION,
  localHealthSchema,
} from '../tools/local-development/config.ts';
import {
  dayStateSchema,
  captureStateSchema,
  boardViewSchema,
} from '../packages/contracts/dist/index.js';

if (
  process.env.GCLOUD_PROJECT !== LOCAL_PROJECT ||
  !process.env.PUZZLE_LOCAL_VERIFY_FIXTURE
)
  throw new Error('Persistence verification is local-test-only');
const fixture = JSON.parse(
  await readFile(process.env.PUZZLE_LOCAL_VERIFY_FIXTURE, 'utf8'),
);
const endpoint = `http://127.0.0.1:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}`;
const health = localHealthSchema.parse(
  await (await fetch(`${endpoint}/localHealth?probe=${randomUUID()}`)).json(),
);
assert.equal(health.runId, fixture.runId);
const refreshed = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.auth}/securetoken.googleapis.com/v1/token?key=emulator-only`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: fixture.refreshToken,
    }),
    signal: AbortSignal.timeout(10000),
  },
);
assert.equal(refreshed.status, 200);
const credential = await refreshed.json();
assert.equal(credential.user_id, fixture.uid);
async function call(name, data, token = credential.id_token) {
  const response = await fetch(`${endpoint}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data: { runId: fixture.runId, data } }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
const day = dayStateSchema.parse(await call('getDayState', {}));
const previous = captureStateSchema.parse(
  await call('getCapture', { captureId: fixture.captureId }),
);
// No repeated acknowledgement: the imported server record must authorize begin.
const next = captureStateSchema.parse(await call('beginCapture', {}));
if (day.dayKey === fixture.dayKey) {
  assert.equal(previous.status, 'open');
  assert.equal(next.captureId, fixture.captureId);
} else {
  assert.equal(previous.status, 'expired');
  assert.equal(next.dayKey, day.dayKey);
  assert.notEqual(next.captureId, fixture.captureId);
}
// Verify the independently published photo/view after importing Auth, Firestore and Storage.
const photo = JSON.parse(
  await readFile(`${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.photo`, 'utf8'),
);
assert.equal(photo.runId, health.runId);
const photoRefresh = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.auth}/securetoken.googleapis.com/v1/token?key=emulator-only`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: photo.refreshToken,
    }),
    signal: AbortSignal.timeout(10000),
  },
);
assert.equal(photoRefresh.status, 200);
const photoToken = (await photoRefresh.json()).id_token;
const saved = captureStateSchema.parse(
  await call('getCapture', { captureId: photo.captureId }, photoToken),
);
assert.equal(saved.status, 'approved');
assert.equal(saved.boardId, photo.boardId);
const view = boardViewSchema.parse(
  await call('syncBoardView', { boardId: photo.boardId }, photoToken),
);
assert.equal(view.pieces[0].id, photo.pieceId);
const media = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${photo.pieceId}/image`)}?alt=media`,
  {
    headers: { Authorization: `Bearer ${photoToken}` },
    signal: AbortSignal.timeout(10000),
  },
);
assert.equal(media.status, 200);
assert.equal(
  createHash('sha256')
    .update(Buffer.from(await media.arrayBuffer()))
    .digest('hex'),
  photo.hash,
);
const deleted = JSON.parse(
  await readFile(`${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.deleted`, 'utf8'),
);
assert.equal(deleted.runId, health.runId);
const deletionRefresh = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.auth}/securetoken.googleapis.com/v1/token?key=emulator-only`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: deleted.refreshToken,
    }),
    signal: AbortSignal.timeout(10000),
  },
);
assert.equal(deletionRefresh.status, 200);
const deletedToken = (await deletionRefresh.json()).id_token;
const deletedDay = dayStateSchema.parse(
  await call('getDayState', {}, deletedToken),
);
if (deletedDay.dayKey === deleted.dayKey)
  assert.equal(deletedDay.photoState, 'unavailable');
const blank = boardViewSchema.parse(
  await call('syncBoardView', { boardId: deleted.boardId }, deletedToken),
);
assert.equal(blank.pieces[0].visibility, 'blank');
assert.equal(blank.pieces[0].username, null);
assert.equal(blank.pieces[0].caption, null);
const deletedMedia = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${deleted.pieceId}/image`)}?alt=media`,
  {
    headers: { Authorization: `Bearer ${deletedToken}` },
    signal: AbortSignal.timeout(10000),
  },
);
assert.notEqual(deletedMedia.status, 200);
await deletedMedia.arrayBuffer();
console.log(
  'Local deleted-photo restart checks passed: blank piece and inaccessible image survive export/import.',
);
const reported = JSON.parse(
  await readFile(`${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.reported`, 'utf8'),
);
assert.equal(reported.runId, health.runId);
const reportTokens = await Promise.all(
  [reported.reporterRefreshToken, reported.targetRefreshToken].map(
    async (token) => {
      const response = await fetch(
        `http://127.0.0.1:${LOCAL_PORTS.auth}/securetoken.googleapis.com/v1/token?key=emulator-only`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: token,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200);
      return (await response.json()).id_token;
    },
  ),
);
const reportedView = boardViewSchema.parse(
  await call('syncBoardView', { boardId: reported.boardId }, reportTokens[0]),
);
assert.equal(
  reportedView.pieces.find((piece) => piece.id === reported.pieceId).visibility,
  'blank',
);
const targetView = boardViewSchema.parse(
  await call('syncBoardView', { boardId: reported.boardId }, reportTokens[1]),
);
assert.ok(targetView.pieces.every((piece) => piece.visibility === 'visible'));
assert.deepEqual(
  await call(
    'reportPhoto',
    { pieceId: reported.pieceId, reason: 'harassment' },
    reportTokens[0],
  ),
  { status: 'reported' },
);
const reportedMedia = await fetch(
  `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${reported.pieceId}/image`)}?alt=media`,
  {
    headers: { Authorization: `Bearer ${reportTokens[0]}` },
    signal: AbortSignal.timeout(10000),
  },
);
assert.equal(reportedMedia.status, 403);
await reportedMedia.arrayBuffer();
console.log(
  'Local report restart checks passed: reporter-only blanking and image denial survive export/import.',
);
const blocked = JSON.parse(
  await readFile(`${process.env.PUZZLE_LOCAL_VERIFY_FIXTURE}.blocked`, 'utf8'),
);
assert.equal(blocked.runId, health.runId);
const blockTokens = await Promise.all(
  [blocked.blockerRefreshToken, blocked.targetRefreshToken].map(
    async (refreshToken) => {
      const response = await fetch(
        `http://127.0.0.1:${LOCAL_PORTS.auth}/securetoken.googleapis.com/v1/token?key=emulator-only`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200);
      return (await response.json()).id_token;
    },
  ),
);
for (const [token, pieceId] of [
  [blockTokens[0], blocked.pieceId],
  [blockTokens[1], blocked.ownPieceId],
]) {
  const view = boardViewSchema.parse(
    await call('syncBoardView', { boardId: blocked.boardId }, token),
  );
  assert.equal(view.pieces.find((p) => p.id === pieceId).visibility, 'blank');
  assert.equal(view.pieces.filter((p) => p.visibility === 'visible').length, 2);
  const denied = await fetch(
    `http://127.0.0.1:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${pieceId}/image`)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();
}
assert.deepEqual(
  await call('blockPhoto', { pieceId: blocked.pieceId }, blockTokens[0]),
  { status: 'blocked' },
);
console.log(
  'Local safety-block restart checks passed: both views remain blank and both image gates remain closed after export/import.',
);
console.log(
  'Local restart verification passed: Auth refresh, acknowledgement, day-bound session, authorized board view and exact image bytes survived export/import.',
);
