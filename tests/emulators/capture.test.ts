import {
  CaptureService,
  type PhotoProcessor,
} from '../../apps/functions/src/services/capture';
import { privateCaptureSchema } from '../../apps/functions/src/domain/capture';
import { Backend } from '../../apps/functions/src/services/backend';
import { paths } from '../../apps/functions/src/repositories/paths';
import { PhotoDeletionService } from '../../apps/functions/src/services/photo-deletion';
import type { Decision } from '../../apps/functions/src/domain/moderation';
import { db, reset, backend, safety, NOW, DAY } from './helpers';
class ArtificialPhotos implements PhotoProcessor {
  objects = new Map<string, Buffer>();
  decision: Decision = 'approved';
  outage = false;
  failRemoval = false;
  onProcess: (() => void) | null = null;
  async has(path: string) {
    return this.objects.has(path);
  }
  async save(path: string, image: Buffer) {
    const old = this.objects.get(path);
    if (old && !old.equals(image)) throw new Error('Immutable upload');
    this.objects.set(path, image);
  }
  async remove(path: string) {
    if (this.failRemoval) throw new Error('Synthetic removal outage');
    this.objects.delete(path);
  }
  async process() {
    this.onProcess?.();
    if (this.outage) throw new Error('Synthetic moderation outage');
    return {
      decision: this.decision,
      image: Buffer.from('synthetic re-encoded image'),
    };
  }
}
let photos: ArtificialPhotos;
let service: CaptureService;
let now: number;
beforeEach(async () => {
  await reset();
  photos = new ArtificialPhotos();
  now = NOW;
  service = new CaptureService(db, photos, 'v1', () => now);
});
async function owner(uid = 'owner') {
  await backend.getDayState(uid);
  await service.acceptOnboarding(uid, {
    age16OrOlder: true,
    accepted: true,
    legalVersion: 'v1',
  });
  return service.begin(uid);
}
async function uploaded(uid = 'owner') {
  const capture = await owner(uid);
  await service.upload(uid, {
    captureId: capture.captureId,
    base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  });
  return capture;
}
const input = (captureId: string) => ({
  captureId,
  username: '人工署名',
  caption: '人工キャプション',
});
test('capture requires active anonymous subject and explicit current consent', async () => {
  await backend.getDayState('owner');
  await expect(service.begin('owner')).rejects.toThrow('permission-denied');
  await expect(
    service.acceptOnboarding('owner', {
      age16OrOlder: false,
      accepted: true,
      legalVersion: 'v1',
    }),
  ).rejects.toThrow();
  await expect(
    service.acceptOnboarding('owner', {
      age16OrOlder: true,
      accepted: true,
      legalVersion: 'old',
    }),
  ).rejects.toThrow();
  await owner();
  await safety.setSubjectStatus('owner', 'suspended');
  await expect(service.begin('owner')).rejects.toThrow('permission-denied');
});
test('capture is retryable, owner-only and does not reveal a shape before approval', async () => {
  const capture = await owner();
  expect(await service.begin('owner')).toEqual(capture);
  await owner('other');
  await expect(service.get('other', capture.captureId)).rejects.toThrow(
    'permission-denied',
  );
  await expect(
    service.upload('other', {
      captureId: capture.captureId,
      base64: '/9j/2Q==',
    }),
  ).rejects.toThrow('permission-denied');
  expect(JSON.stringify(capture)).not.toMatch(
    /edges|pieceId|ownerUid|safetyId/,
  );
  expect((await db.collection('pieces').get()).empty).toBe(true);
  expect((await db.collection('mediaAccess').get()).empty).toBe(true);
});
test('missing upload remains open for re-capture rather than publishing or locking permanently', async () => {
  const capture = await owner();
  expect((await service.submit('owner', input(capture.captureId))).status).toBe(
    'open',
  );
  expect((await db.collection('pieces').get()).empty).toBe(true);
});
test('approval alone publishes one server-generated piece and cleans the raw image', async () => {
  const capture = await uploaded();
  const result = await service.submit('owner', input(capture.captureId));
  expect(result.status).toBe('approved');
  expect(result.boardId).toBeTruthy();
  expect(photos.objects.has(capture.uploadPath)).toBe(false);
  const state = await backend.getDayState('owner');
  expect(state.photoState).toBe('ready');
  const piece = (
    await db.doc(paths.piece(state.ownPieceId ?? 'missing')).get()
  ).data();
  expect(piece).toMatchObject({
    username: '人工署名',
    caption: '人工キャプション',
    dayKey: DAY,
  });
  expect(piece).toHaveProperty('edges');
  expect(await service.submit('owner', input(capture.captureId))).toEqual(
    result,
  );
  await expect(service.begin('owner')).rejects.toThrow('failed-precondition');
});
test.each(['held', 'rejected'] as const)(
  '%s never creates participant data or an image grant',
  async (decision) => {
    photos.decision = decision;
    const capture = await uploaded();
    expect(
      (await service.submit('owner', input(capture.captureId))).status,
    ).toBe(decision);
    expect((await db.collection('pieces').get()).empty).toBe(true);
    expect((await backend.getDayState('owner')).photoState).toBe('not-created');
    expect(photos.objects.has(capture.uploadPath)).toBe(false);
    if (decision === 'held') {
      expect(
        (await db.doc(`reviewQueue/${capture.captureId}`).get()).exists,
      ).toBe(true);
      expect((await service.begin('owner')).captureId).toBe(capture.captureId);
    } else
      expect((await service.begin('owner')).captureId).not.toBe(
        capture.captureId,
      );
  },
);
test('moderation outage fails closed and allows same-input retry without a duplicate piece', async () => {
  photos.outage = true;
  const capture = await uploaded();
  expect((await service.submit('owner', input(capture.captureId))).status).toBe(
    'error',
  );
  expect((await db.collection('pieces').get()).empty).toBe(true);
  await expect(
    service.submit('owner', {
      ...input(capture.captureId),
      caption: '差し替え',
    }),
  ).rejects.toThrow('failed-precondition');
  photos.outage = false;
  expect((await service.submit('owner', input(capture.captureId))).status).toBe(
    'approved',
  );
  expect((await db.collection('pieces').get()).size).toBe(1);
});
test('concurrent submissions produce at most one canonical daily piece', async () => {
  const capture = await uploaded();
  await Promise.all([
    service.submit('owner', input(capture.captureId)),
    service.submit('owner', input(capture.captureId)),
  ]);
  expect((await service.get('owner', capture.captureId)).status).toBe(
    'approved',
  );
  expect((await db.collection('pieces').get()).size).toBe(1);
});
test.each(['approved', 'held'] as const)(
  '4am crossing during %s moderation never publishes and removes orphans',
  async (decision) => {
    photos.decision = decision;
    const capture = await uploaded();
    photos.onProcess = () => {
      now = Date.parse('2026-10-10T19:00:00Z');
    };
    expect(
      (await service.submit('owner', input(capture.captureId))).status,
    ).toBe('expired');
    expect((await db.collection('pieces').get()).empty).toBe(true);
    await service.cleanupExpired();
    expect(photos.objects.size).toBe(0);
    expect((await db.collection('captureCleanup').get()).empty).toBe(true);
  },
);
test('expiration denies late uploads and permits the new server day', async () => {
  const capture = await owner();
  now = Date.parse('2026-10-10T19:00:00Z');
  await expect(
    service.upload('owner', {
      captureId: capture.captureId,
      base64: '/9j/2Q==',
    }),
  ).rejects.toThrow('failed-precondition');
  expect((await service.get('owner', capture.captureId)).status).toBe(
    'expired',
  );
  expect((await service.begin('owner')).dayKey).toBe('2026-10-11');
});
test('recovers publication before capture-state completion even after 4am', async () => {
  const capture = await uploaded();
  const privateState = privateCaptureSchema.parse(
    (await db.doc(`captures/${capture.captureId}`).get()).data(),
  );
  if (!privateState) throw new Error('Missing fixture');
  await db.doc(paths.approval(capture.captureId)).set({
    ownerUid: 'owner',
    dayKey: DAY,
    status: 'approved',
    normalizedPieceId: privateState.pieceId,
    username: '人工署名',
    caption: '人工キャプション',
  });
  await new Backend(db, () => now).publishApprovedPiece(capture.captureId);
  now = Date.parse('2026-10-10T19:00:00Z');
  expect((await service.get('owner', capture.captureId)).status).toBe(
    'approved',
  );
  await service.cleanupExpired();
  expect((await db.collection('pieces').get()).size).toBe(1);
});
test('cleanup retains private retry jobs after removal failure', async () => {
  const capture = await uploaded();
  photos.failRemoval = true;
  await service.submit('owner', input(capture.captureId));
  expect(
    (await db.doc(`captureCleanup/${capture.captureId}`).get()).get(
      'rawRemovalPending',
    ),
  ).toBe(true);
  now = Date.parse('2026-10-10T19:00:00Z');
  await service.cleanupExpired();
  expect(
    (await db.doc(`captureCleanup/${capture.captureId}`).get()).exists,
  ).toBe(true);
  photos.failRemoval = false;
  await service.cleanupExpired();
  expect(photos.objects.has(capture.uploadPath)).toBe(false);
  expect(
    (await db.doc(`captureCleanup/${capture.captureId}`).get()).exists,
  ).toBe(false);
});

test('expiration cleanup racing normalized save cannot orphan or delete a published photo', async () => {
  const capture = await uploaded();
  const save = photos.save.bind(photos);
  let intercepted = false;
  photos.save = async (path, image) => {
    if (path.startsWith('normalized/') && !intercepted) {
      intercepted = true;
      now = Date.parse('2026-10-10T19:00:00Z');
      await service.cleanupExpired();
    }
    await save(path, image);
  };
  expect((await service.submit('owner', input(capture.captureId))).status).toBe(
    'expired',
  );
  expect((await db.collection('pieces').get()).empty).toBe(true);
  expect(
    (await db.doc(`captureCleanup/${capture.captureId}`).get()).exists,
  ).toBe(true);
  await service.cleanupExpired();
  expect(photos.objects.size).toBe(0);
});

test('a superseded processor finishing after deletion cannot leave the normalized photo behind', async () => {
  const capture = await uploaded();
  const save = photos.save.bind(photos);
  let release = () => {};
  let reached = () => {};
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let intercepted = false;
  photos.save = async (path, image) => {
    if (path.startsWith('normalized/') && !intercepted) {
      intercepted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
        reached();
      });
    }
    await save(path, image);
  };
  const old = service.submit('owner', input(capture.captureId));
  await waiting;
  now += 121000;
  expect((await service.submit('owner', input(capture.captureId))).status).toBe(
    'approved',
  );
  const pieceId = (await backend.getDayState('owner')).ownPieceId!;
  await new PhotoDeletionService(db, photos).removeOwn('owner', pieceId);
  release();
  await old;
  expect(photos.objects.has(`normalized/${pieceId}/image`)).toBe(false);
  expect((await backend.getDayState('owner')).photoState).toBe('unavailable');
});
test('expiration cleanup removes a deleted piece’s late orphan without changing its geometry', async () => {
  const capture = await uploaded();
  await service.submit('owner', input(capture.captureId));
  const day = await backend.getDayState('owner');
  await new PhotoDeletionService(db, photos).removeOwn(
    'owner',
    day.ownPieceId!,
  );
  const before = (await db.doc(paths.board(day.boardId!)).get()).data();
  await photos.save(
    `normalized/${day.ownPieceId!}/image`,
    Buffer.from('late synthetic image'),
  );
  now = Date.parse('2026-10-10T19:00:00Z');
  await service.cleanupExpired();
  expect(photos.objects.size).toBe(0);
  expect((await db.doc(paths.board(day.boardId!)).get()).data()).toEqual(
    before,
  );
});
