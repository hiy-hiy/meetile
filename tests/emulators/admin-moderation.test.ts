import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID, createHash } from 'node:crypto';
import { AdminModerationService } from '../../apps/functions/src/services/admin-moderation';
import { Backend } from '../../apps/functions/src/services/backend';
import { CaptureService } from '../../apps/functions/src/services/capture';
import { ReportingService } from '../../apps/functions/src/services/reporting';
import { PhotoDeletionService } from '../../apps/functions/src/services/photo-deletion';
import { paths } from '../../apps/functions/src/repositories/paths';
import {
  db,
  reset,
  backend,
  safety,
  seedBoard,
  NOW,
  session,
  IN,
} from './helpers';

const service = new AdminModerationService(db, () => NOW);
beforeEach(reset);
async function fixture() {
  const all = await seedBoard('moderation', 3);
  const [reporter, target, observer] = all.members;
  if (!reporter || !target || !observer)
    throw new Error('Missing artificial members');
  await new ReportingService(db, () => NOW).report(reporter.uid, {
    pieceId: target.pieceId,
    reason: 'other',
  });
  await db.doc('adminOperators/operator').set({ enabled: true });
  return {
    ...all,
    reporter,
    target,
    observer,
    caseId: paths.report(reporter.uid, target.pieceId).split('/')[1]!,
  };
}
test('every moderation operation denies unlisted or disabled operators without writing audit or decisions', async () => {
  const f = await fixture();
  await db.doc('adminOperators/operator').set({ enabled: false });
  for (const uid of ['stranger', 'operator']) {
    await expect(service.list(uid, {})).rejects.toThrow('permission-denied');
    await expect(service.detail(uid, f.caseId)).rejects.toThrow(
      'permission-denied',
    );
    await expect(service.imageTarget(uid, f.caseId)).rejects.toThrow(
      'permission-denied',
    );
    await expect(
      service.suspend(uid, {
        caseId: f.caseId,
        requestId: randomUUID(),
        note: '人工検証',
      }),
    ).rejects.toThrow('permission-denied');
    await expect(
      service.decide(uid, {
        caseId: f.caseId,
        requestId: randomUUID(),
        decision: 'remove',
        note: '人工検証',
      }),
    ).rejects.toThrow('permission-denied');
  }
  expect((await db.collection('adminAudit').get()).empty).toBe(true);
  expect((await db.collection('adminDecisions').get()).empty).toBe(true);
});
test('operator DTOs omit safety identities; list, text and image access are audited', async () => {
  const f = await fixture();
  const list = await service.list('operator', {}),
    detail = await service.detail('operator', f.caseId);
  expect(list.reports).toHaveLength(1);
  expect(detail.related).toHaveLength(1);
  const serialized = JSON.stringify({ list, detail });
  for (const value of [
    f.reporter.uid,
    f.target.uid,
    'reporterUid',
    'ownerUid',
    'reviewerUid',
    'safetyId',
  ])
    expect(serialized).not.toContain(value);
  expect(await service.imageTarget('operator', f.caseId)).toBe(
    `normalized/${f.target.pieceId}/image`,
  );
  expect(
    (await db.collection('adminAudit').get()).docs.map(
      (doc) => doc.get('action') as unknown,
    ),
  ).toEqual(
    expect.arrayContaining(['list-reports', 'view-report', 'view-image']),
  );
});
test('dismissal records the reason but does not restore the reporter’s photo or alter anyone else’s view', async () => {
  const f = await fixture();
  const before = (await db.doc(paths.board(f.boardId)).get()).data();
  await service.decide('operator', {
    caseId: f.caseId,
    requestId: randomUUID(),
    decision: 'dismiss',
    note: '人工図形として確認',
  });
  expect((await service.list('operator', {})).reports).toHaveLength(0);
  expect((await service.detail('operator', f.caseId)).report).toMatchObject({
    status: 'reviewed',
    decision: 'dismiss',
    note: '人工図形として確認',
  });
  expect(
    (await backend.syncBoardView(f.reporter.uid, f.boardId)).pieces.find(
      (p) => p.id === f.target.pieceId,
    )?.visibility,
  ).toBe('blank');
  expect(
    (await backend.syncBoardView(f.observer.uid, f.boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
  expect((await db.doc(paths.board(f.boardId)).get()).data()).toEqual(before);
});
test('removal, decision and audit commit together; image access closes and all text copies are scrubbed without geometry changes', async () => {
  const f = await fixture();
  const before = (await db.doc(paths.board(f.boardId)).get()).data();
  const input = {
    caseId: f.caseId,
    requestId: randomUUID(),
    decision: 'remove',
    note: '内部検証の無地化',
  };
  expect(await service.decide('operator', input)).toEqual({
    status: 'reviewed',
  });
  expect(
    (await db.doc(paths.piece(f.target.pieceId)).get()).data(),
  ).toMatchObject({ status: 'removed', username: null, caption: null });
  expect((await db.doc(paths.media(f.target.pieceId)).get()).data()).toEqual({
    visible: false,
    epochs: {},
  });
  for (const member of f.members)
    expect(
      (await db.doc(paths.view(member.uid, f.boardId)).get()).get('pieces'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.target.pieceId,
          visibility: 'blank',
          username: null,
          caption: null,
        }),
      ]),
    );
  expect((await backend.getDayState(f.target.uid)).photoState).toBe(
    'unavailable',
  );
  expect((await db.doc(paths.board(f.boardId)).get()).data()).toEqual(before);
  await expect(service.imageTarget('operator', f.caseId)).rejects.toThrow(
    'not-found',
  );
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'remove-photo')
        .get()
    ).size,
  ).toBe(1);
  const remove = jest.fn(async () => {});
  await new PhotoDeletionService(db, { remove }).cleanup();
  expect(remove).toHaveBeenCalledWith(`normalized/${f.target.pieceId}/image`);
  expect((await db.collection('deletionJobs').get()).empty).toBe(true);
});
test('duplicate decisions are idempotent and conflicting requests or a second operator cannot overwrite a completed review', async () => {
  const f = await fixture();
  const input = {
    caseId: f.caseId,
    requestId: randomUUID(),
    decision: 'remove',
    note: '人工検証',
  };
  await Promise.all([
    service.decide('operator', input),
    service.decide('operator', input),
  ]);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'remove-photo')
        .get()
    ).size,
  ).toBe(1);
  await expect(
    service.decide('operator', { ...input, decision: 'dismiss' }),
  ).rejects.toThrow('failed-precondition');
  await db.doc('adminOperators/second').set({ enabled: true });
  await expect(
    service.decide('second', { ...input, requestId: randomUUID() }),
  ).rejects.toThrow('failed-precondition');
  expect((await db.doc(`reports/${f.caseId}`).get()).get('decision')).toBe(
    'remove',
  );
});
test('owner deletion racing moderation never republishes the photo; the decision remains recorded', async () => {
  const f = await fixture();
  await Promise.all([
    safety.removeOwnPiece(f.target.uid, f.target.pieceId),
    service.decide('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      decision: 'remove',
      note: '人工検証',
    }),
  ]);
  const piece = (await db.doc(paths.piece(f.target.pieceId)).get()).data();
  expect(['deleted', 'removed']).toContain(piece?.status);
  expect(piece?.username).toBeNull();
  expect((await db.doc(`reports/${f.caseId}`).get()).get('status')).toBe(
    'reviewed',
  );
  expect(
    (await backend.syncBoardView(f.observer.uid, f.boardId)).pieces.find(
      (p) => p.id === f.target.pieceId,
    )?.visibility,
  ).toBe('blank');
});
test('logout removes the individual server-side session and audits it; revoking the allowlist prevents further actions', async () => {
  await fixture();
  const hash = createHash('sha256').update('synthetic-cookie').digest('hex');
  await service.beginSession('operator', hash, NOW + 10000, null);
  expect((await db.doc(`adminSessions/${hash}`).get()).exists).toBe(true);
  await service.endSession('operator', hash);
  expect((await db.doc(`adminSessions/${hash}`).get()).exists).toBe(false);
  await db.doc('adminOperators/operator').update({ enabled: false });
  await expect(service.list('operator', {})).rejects.toThrow(
    'permission-denied',
  );
});

test('queue pagination and related reports stay bounded and do not skip or repeat cases', async () => {
  const f = await fixture();
  const batch = db.batch();
  for (let index = 0; index < 28; index++)
    batch.create(
      db.doc(paths.report(`synthetic-more-${index}`, f.target.pieceId)),
      {
        reporterUid: `synthetic-more-${index}`,
        pieceId: f.target.pieceId,
        dayKey: '2026-10-10',
        reason: 'other',
        status: 'pending',
        createdAtMs: NOW + index,
      },
    );
  await batch.commit();
  const first = await service.list('operator', {});
  expect(first.reports).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await service.list('operator', { cursor: first.nextCursor });
  expect(second.reports).toHaveLength(4);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.reports, ...second.reports].map((report) => report.caseId),
    ).size,
  ).toBe(29);
  const detail = await service.detail('operator', f.caseId);
  expect(detail.related).toHaveLength(20);
  expect(detail.moreRelated).toBe(true);
});

test('suspension, reason, receipt and audit commit once; stale views and future-day activity stay denied', async () => {
  const f = await fixture();
  const before = (await db.doc(paths.board(f.boardId)).get()).data();
  const revision = (await db.doc(paths.clientState(f.target.uid)).get()).get(
    'accessRevision',
  ) as number;
  const input = {
    caseId: f.caseId,
    requestId: randomUUID(),
    note: '人工素材による停止確認',
  };
  await Promise.all([
    service.suspend('operator', input),
    service.suspend('operator', input),
  ]);
  expect((await db.doc(paths.subject(f.target.uid)).get()).data()).toEqual({
    status: 'suspended',
    accessEpoch: 1,
  });
  expect(
    (await db.doc(paths.clientState(f.target.uid)).get()).get('accessRevision'),
  ).toBe(revision + 1);
  expect((await db.collection('adminSuspensions').get()).size).toBe(1);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'suspend-user')
        .get()
    ).size,
  ).toBe(1);
  const detail = await service.detail('operator', f.caseId);
  expect(detail).toMatchObject({
    subjectState: 'suspended',
    suspension: { note: input.note, atMs: NOW, changed: true },
    report: { status: 'pending' },
  });
  expect(JSON.stringify(detail)).not.toContain(f.target.uid);
  await expect(backend.getDayState(f.target.uid)).rejects.toThrow(
    'permission-denied',
  );
  await expect(backend.syncBoardView(f.target.uid, f.boardId)).rejects.toThrow(
    'permission-denied',
  );
  await expect(
    backend.confirmFit(f.target.uid, 'missing-session'),
  ).rejects.toThrow();
  await expect(
    new Backend(db, () => NOW + 86400000).getDayState(f.target.uid),
  ).rejects.toThrow('permission-denied');
  const capture = new CaptureService(
    db,
    {
      has: async () => false,
      save: async () => {},
      remove: async () => {},
      process: async () => {
        throw new Error('must not process');
      },
    },
    'v1',
    () => NOW,
  );
  await expect(
    capture.acceptOnboarding(f.target.uid, {
      age16OrOlder: true,
      accepted: true,
      legalVersion: 'v1',
    }),
  ).rejects.toThrow('permission-denied');
  await expect(capture.begin(f.target.uid)).rejects.toThrow(
    'permission-denied',
  );
  expect(
    (await backend.syncBoardView(f.observer.uid, f.boardId)).pieces.every(
      (p) => p.visibility === 'visible',
    ),
  ).toBe(true);
  expect((await db.doc(paths.board(f.boardId)).get()).data()).toEqual(before);
  expect(
    (await db.doc(paths.piece(f.target.pieceId)).get()).get('status'),
  ).toBe('approved');
});

test('suspension refuses forged owners, empty reasons, changed retries and overwriting a case reason', async () => {
  const f = await fixture();
  const input = { caseId: f.caseId, requestId: randomUUID(), note: '人工検証' };
  await expect(
    service.suspend('operator', { ...input, ownerUid: f.observer.uid }),
  ).rejects.toThrow();
  await expect(
    service.suspend('operator', { ...input, note: '  ' }),
  ).rejects.toThrow();
  await expect(
    service.suspend('operator', { ...input, note: 'x'.repeat(501) }),
  ).rejects.toThrow();
  await service.suspend('operator', input);
  await expect(
    service.suspend('operator', { ...input, note: '書き換え' }),
  ).rejects.toThrow('failed-precondition');
  await expect(
    service.suspend('operator', { ...input, requestId: randomUUID() }),
  ).rejects.toThrow('failed-precondition');
  await db.doc('adminOperators/second').set({ enabled: true });
  await expect(
    service.suspend('second', { ...input, requestId: randomUUID() }),
  ).rejects.toThrow('failed-precondition');
  await db.doc('adminOperators/operator').update({ enabled: false });
  await expect(service.suspend('operator', input)).rejects.toThrow(
    'permission-denied',
  );
  expect((await db.collection('adminSuspensions').get()).size).toBe(1);
});

test('reviewed and removed photos still identify the subject privately; photo decisions remain unchanged', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  await service.decide('operator', {
    caseId: f.caseId,
    requestId,
    decision: 'remove',
    note: '写真への判断',
  });
  const before = (await db.doc(`reports/${f.caseId}`).get()).data();
  await service.suspend('operator', {
    caseId: f.caseId,
    requestId,
    note: '利用停止の理由',
  });
  expect((await service.detail('operator', f.caseId)).subjectState).toBe(
    'suspended',
  );
  expect((await db.doc(`reports/${f.caseId}`).get()).data()).toEqual(before);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'remove-photo')
        .get()
    ).size,
  ).toBe(1);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'suspend-user')
        .get()
    ).size,
  ).toBe(1);
});

test('another report can record an existing suspension without incrementing its epoch again', async () => {
  const f = await fixture();
  await new ReportingService(db, () => NOW).report(f.observer.uid, {
    pieceId: f.target.pieceId,
    reason: 'other',
  });
  const otherId = paths.report(f.observer.uid, f.target.pieceId).split('/')[1]!;
  await Promise.all([
    service.suspend('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      note: '人工検証A',
    }),
    service.suspend('operator', {
      caseId: otherId,
      requestId: randomUUID(),
      note: '人工検証B',
    }),
  ]);
  expect(
    (await db.doc(paths.subject(f.target.uid)).get()).get('accessEpoch'),
  ).toBe(1);
  expect((await db.collection('adminCaseSuspensions').get()).size).toBe(2);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'suspend-user')
        .get()
    ).size,
  ).toBe(1);
  expect(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'confirm-suspension')
        .get()
    ).size,
  ).toBe(1);
});

test('ended or missing subjects and missing cases are never revived or given suspension receipts', async () => {
  const f = await fixture();
  const input = { caseId: f.caseId, requestId: randomUUID(), note: '人工検証' };
  await safety.setSubjectStatus(f.target.uid, 'ended');
  await expect(service.suspend('operator', input)).rejects.toThrow(
    'failed-precondition',
  );
  await db.doc(paths.subject(f.target.uid)).delete();
  await expect(service.suspend('operator', input)).rejects.toThrow('not-found');
  await expect(
    service.suspend('operator', { ...input, caseId: '0'.repeat(64) }),
  ).rejects.toThrow('not-found');
  expect((await db.collection('adminSuspensions').get()).empty).toBe(true);
});

test('a valid in-progress FIT and approved publication cannot complete after suspension', async () => {
  const f = await fixture();
  const other = await seedBoard('fit-other', 1, IN);
  await session('before-stop', f.target.uid, other.uid);
  expect((await backend.confirmFit(f.target.uid, 'before-stop')).status).toBe(
    'waiting',
  );
  const before = (await db.collection('boards').get()).size;
  const approvalId = randomUUID();
  await db.doc(paths.approval(approvalId)).set({
    ownerUid: f.target.uid,
    dayKey: '2026-10-10',
    status: 'approved',
    normalizedPieceId: randomUUID(),
    username: '人工署名',
    caption: '人工素材',
  });
  await service.suspend('operator', {
    caseId: f.caseId,
    requestId: randomUUID(),
    note: '人工FIT途中の停止',
  });
  await expect(backend.confirmFit(other.uid, 'before-stop')).rejects.toThrow(
    'permission-denied',
  );
  await expect(backend.confirmFit(f.target.uid, 'before-stop')).rejects.toThrow(
    'permission-denied',
  );
  await expect(backend.publishApprovedPiece(approvalId)).rejects.toThrow(
    'permission-denied',
  );
  expect((await db.collection('boards').get()).size).toBe(before);
});
describe('re-review of decisions and suspensions', () => {
  const reReview = (
    caseId: string,
    target: 'decision' | 'suspension',
    outcome: 'upheld' | 'overturned',
    requestId: string = randomUUID(),
  ) => ({ caseId, requestId, target, outcome, note: '人工検証の再確認' });
  async function decided(decision: 'dismiss' | 'remove') {
    const f = await fixture();
    await db.doc('adminOperators/second').set({ enabled: true });
    await service.decide('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      decision,
      note: '人工検証の判断',
    });
    return f;
  }
  test('the original operator cannot re-review their own decision or suspension', async () => {
    const f = await decided('dismiss');
    await service.suspend('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      note: '人工検証の停止',
    });
    const detail = await service.detail('operator', f.caseId);
    expect(detail).toMatchObject({ ownDecision: true, ownSuspension: true });
    for (const target of ['decision', 'suspension'] as const)
      await expect(
        service.reReview('operator', reReview(f.caseId, target, 'upheld')),
      ).rejects.toThrow('permission-denied');
    expect((await db.collection('adminReReviews').get()).empty).toBe(true);
    expect(await service.detail('second', f.caseId)).toMatchObject({
      ownDecision: false,
      ownSuspension: false,
    });
  });
  test('upholding records the review without changing the photo or the original record', async () => {
    const f = await decided('dismiss');
    expect(
      await service.reReview(
        'second',
        reReview(f.caseId, 'decision', 'upheld'),
      ),
    ).toEqual({ status: 'recorded', effect: 'none' });
    expect(
      (await db.doc(paths.piece(f.target.pieceId)).get()).get('status'),
    ).toBe('approved');
    const detail = await service.detail('second', f.caseId);
    expect(detail.report).toMatchObject({
      decision: 'dismiss',
      note: '人工検証の判断',
    });
    expect(detail.reReviews.decision).toEqual({
      outcome: 'upheld',
      note: '人工検証の再確認',
      atMs: NOW,
      original: 'dismiss',
      effect: 'none',
    });
    const serialized = JSON.stringify(detail);
    for (const value of [
      'reviewerUid',
      'fingerprint',
      'operatorUid',
      'operator"',
    ])
      expect(serialized).not.toContain(value);
  });
  test('an overturned dismissal removes the photo atomically with the record and audit', async () => {
    const f = await decided('dismiss');
    expect(
      await service.reReview(
        'second',
        reReview(f.caseId, 'decision', 'overturned'),
      ),
    ).toEqual({ status: 'recorded', effect: 'removed' });
    expect(
      (await db.doc(paths.piece(f.target.pieceId)).get()).data(),
    ).toMatchObject({ status: 'removed', username: null, caption: null });
    expect(
      (await db.doc(paths.media(f.target.pieceId)).get()).get('visible'),
    ).toBe(false);
    expect(
      (await db.doc(`deletionJobs/${f.target.pieceId}`).get()).exists,
    ).toBe(true);
    await expect(service.imageTarget('second', f.caseId)).rejects.toThrow(
      'not-found',
    );
    expect((await db.doc(`reports/${f.caseId}`).get()).get('decision')).toBe(
      'dismiss',
    );
    expect(
      (
        await db
          .collection('adminAudit')
          .where('action', '==', 'rereview-decision-overturned')
          .get()
      ).size,
    ).toBe(1);
  });
  test('an overturned removal or suspension is recorded only: nothing is restored or lifted', async () => {
    const f = await decided('remove');
    await service.suspend('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      note: '人工検証の停止',
    });
    for (const target of ['decision', 'suspension'] as const)
      expect(
        await service.reReview(
          'second',
          reReview(f.caseId, target, 'overturned'),
        ),
      ).toEqual({ status: 'recorded', effect: 'none' });
    expect(
      (await db.doc(paths.piece(f.target.pieceId)).get()).get('status'),
    ).toBe('removed');
    expect(
      (await db.doc(paths.subject(f.target.uid)).get()).get('status'),
    ).toBe('suspended');
  });
  test('suspensions recorded before operator tracking fall back to the audit log', async () => {
    const f = await decided('dismiss');
    await service.suspend('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      note: '人工検証の停止',
    });
    await db
      .doc(`adminCaseSuspensions/${f.caseId}`)
      .update({ operatorUid: FieldValue.delete() });
    expect((await service.detail('operator', f.caseId)).ownSuspension).toBe(
      true,
    );
    await expect(
      service.reReview('operator', reReview(f.caseId, 'suspension', 'upheld')),
    ).rejects.toThrow('permission-denied');
    await service.reReview(
      'second',
      reReview(f.caseId, 'suspension', 'upheld'),
    );
  });
  test('retries are idempotent; a second review, a changed retry or concurrent reviewers cannot overwrite', async () => {
    const f = await decided('dismiss');
    await db.doc('adminOperators/third').set({ enabled: true });
    const requestId = randomUUID();
    const first = reReview(f.caseId, 'decision', 'overturned', requestId);
    const results = await Promise.allSettled([
      service.reReview('second', first),
      service.reReview('third', reReview(f.caseId, 'decision', 'upheld')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner: unknown = (
      await db.collection('adminReReviews').get()
    ).docs[0]?.get('reviewerUid');
    if (winner === 'second') {
      await service.reReview('second', first);
      await expect(
        service.reReview('second', { ...first, note: '変更した理由' }),
      ).rejects.toThrow();
    }
    await expect(
      service.reReview('third', reReview(f.caseId, 'decision', 'overturned')),
    ).rejects.toThrow();
    expect((await db.collection('adminReReviews').get()).size).toBe(1);
  });
  test('pending decisions, missing suspensions and unlisted operators cannot be re-reviewed', async () => {
    const f = await fixture();
    await db.doc('adminOperators/second').set({ enabled: true });
    await expect(
      service.reReview('second', reReview(f.caseId, 'decision', 'upheld')),
    ).rejects.toThrow();
    await service.decide('operator', {
      caseId: f.caseId,
      requestId: randomUUID(),
      decision: 'dismiss',
      note: '人工検証の判断',
    });
    await expect(
      service.reReview('second', reReview(f.caseId, 'suspension', 'upheld')),
    ).rejects.toThrow('not-found');
    await expect(
      service.reReview('stranger', reReview(f.caseId, 'decision', 'upheld')),
    ).rejects.toThrow('permission-denied');
    expect((await db.collection('adminReReviews').get()).empty).toBe(true);
  });
});
