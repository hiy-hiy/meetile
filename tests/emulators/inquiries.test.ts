import { randomUUID } from 'node:crypto';
import { InquiryService } from '../../apps/functions/src/services/inquiries';
import { ReportingService } from '../../apps/functions/src/services/reporting';
import { paths } from '../../apps/functions/src/repositories/paths';
import { db, reset, seedBoard, NOW } from './helpers';

const service = new InquiryService(db, () => NOW);
beforeEach(async () => {
  await reset();
  await db.doc('adminOperators/operator').set({ enabled: true });
  await db.doc('adminOperators/second').set({ enabled: true });
});
const registration = (extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  category: 'deletion',
  externalRef: 'REQ-0001',
  summary: '端末を紛失したため、過去の写真の削除を希望。',
  ...extra,
});
async function reportCase() {
  const { members } = await seedBoard('inquiry', 2);
  const [reporter, target] = members;
  if (!reporter || !target) throw new Error('Missing artificial members');
  await new ReportingService(db, () => NOW).report(reporter.uid, {
    pieceId: target.pieceId,
    reason: 'other',
  });
  return paths.report(reporter.uid, target.pieceId).split('/')[1]!;
}

test('every ledger operation denies unlisted or disabled operators without writing', async () => {
  const { id } = await service.create('operator', registration());
  await db.doc('adminOperators/operator').set({ enabled: false });
  const before = (await db.collection('adminAudit').get()).size;
  for (const uid of ['stranger', 'operator']) {
    await expect(service.create(uid, registration())).rejects.toThrow(
      'permission-denied',
    );
    await expect(service.list(uid, {})).rejects.toThrow('permission-denied');
    await expect(service.detail(uid, id)).rejects.toThrow('permission-denied');
    await expect(
      service.update(uid, { action: 'assign', id, requestId: randomUUID() }),
    ).rejects.toThrow('permission-denied');
  }
  expect((await db.collection('adminAudit').get()).size).toBe(before);
  expect((await db.collection('adminInquiries').get()).size).toBe(1);
});
test('contact details are refused in every free-text field and nothing is stored', async () => {
  for (const value of [
    'taro@example.com',
    '連絡先 090-1234-5678',
    'https://example.com/form',
    'LINE ID: example',
  ]) {
    await expect(
      service.create('operator', registration({ summary: value })),
    ).rejects.toThrow();
    await expect(
      service.create('operator', registration({ externalRef: value })),
    ).rejects.toThrow();
  }
  expect((await db.collection('adminInquiries').get()).empty).toBe(true);
  const { id } = await service.create('operator', registration());
  for (const action of [
    { action: 'note', note: '返信先 taro@example.com' },
    { action: 'close', resolution: 'answered', note: '090-1234-5678へ連絡' },
  ])
    await expect(
      service.update('operator', { ...action, id, requestId: randomUUID() }),
    ).rejects.toThrow();
});
test('registration is idempotent per request and audited without copying the text', async () => {
  const input = registration();
  const first = await service.create('operator', input);
  expect(await service.create('operator', input)).toEqual(first);
  await expect(
    service.create('operator', { ...input, summary: '変更した要約' }),
  ).rejects.toThrow();
  expect((await db.collection('adminInquiries').get()).size).toBe(1);
  const audit = (await db.collection('adminAudit').get()).docs.map((doc) =>
    doc.data(),
  );
  expect(audit).toEqual([
    expect.objectContaining({
      action: 'create-inquiry',
      caseId: first.id,
      operatorUid: 'operator',
    }),
  ]);
  expect(JSON.stringify(audit)).not.toContain('端末を紛失');
});
test('DTOs omit operator identities and show only relative assignment and authorship', async () => {
  const { id } = await service.create('operator', registration());
  await service.update('operator', {
    action: 'assign',
    id,
    requestId: randomUUID(),
  });
  await service.update('operator', {
    action: 'note',
    id,
    requestId: randomUUID(),
    note: '外部窓口で状況を確認中。',
  });
  const mine = await service.detail('operator', id);
  const theirs = await service.detail('second', id);
  expect(mine.inquiry).toMatchObject({
    status: 'in-progress',
    assigned: true,
    assignedToMe: true,
  });
  expect(mine.notes).toEqual([
    { note: '外部窓口で状況を確認中。', atMs: NOW, mine: true },
  ]);
  expect(theirs.inquiry.assignedToMe).toBe(false);
  expect(theirs.notes[0]?.mine).toBe(false);
  const list = await service.list('second', {});
  const serialized = JSON.stringify({ mine, theirs, list });
  for (const value of [
    'operator"',
    'second"',
    'createdBy',
    'assigneeUid',
    'authorUid',
    'fingerprint',
  ])
    expect(serialized).not.toContain(value);
});
test('linking only points at an existing report case and never replaces an earlier link', async () => {
  const caseId = await reportCase();
  await expect(
    service.create('operator', registration({ linkedCaseId: 'f'.repeat(64) })),
  ).rejects.toThrow('not-found');
  const { id } = await service.create('operator', registration());
  await expect(
    service.update('operator', {
      action: 'link',
      id,
      requestId: randomUUID(),
      caseId: 'f'.repeat(64),
    }),
  ).rejects.toThrow('not-found');
  await service.update('operator', {
    action: 'link',
    id,
    requestId: randomUUID(),
    caseId,
  });
  expect((await service.detail('operator', id)).inquiry.linkedCaseId).toBe(
    caseId,
  );
  await expect(
    service.update('second', {
      action: 'link',
      id,
      requestId: randomUUID(),
      caseId,
    }),
  ).rejects.toThrow();
  // The ledger records the request; the report case itself is unchanged.
  expect((await db.doc(`reports/${caseId}`).get()).get('status')).toBe(
    'pending',
  );
});
test('closing is final; retries are idempotent and later changes are refused', async () => {
  const { id } = await service.create('operator', registration());
  const close = {
    action: 'close',
    id,
    requestId: randomUUID(),
    resolution: 'unable-to-verify',
    note: '対象の写真を特定できなかった。',
  };
  await service.update('operator', close);
  await service.update('operator', close);
  expect((await service.detail('operator', id)).inquiry).toMatchObject({
    status: 'closed',
    resolution: 'unable-to-verify',
    resolutionNote: '対象の写真を特定できなかった。',
    closedAtMs: NOW,
  });
  for (const action of [
    { action: 'assign' },
    { action: 'note', note: '追記' },
    { ...close, requestId: randomUUID(), resolution: 'answered' },
  ])
    await expect(
      service.update('second', { ...action, id, requestId: randomUUID() }),
    ).rejects.toThrow();
  expect(
    (await service.list('operator', { status: 'closed' })).inquiries,
  ).toHaveLength(1);
  expect((await service.list('operator', {})).inquiries).toHaveLength(0);
});
test('the active list pages without skipping or repeating entries', async () => {
  const ids = new Set<string>();
  for (let index = 0; index < 27; index++)
    ids.add((await service.create('operator', registration())).id);
  const first = await service.list('operator', {});
  expect(first.inquiries).toHaveLength(25);
  const second = await service.list('operator', {
    cursor: first.nextCursor,
  });
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.inquiries, ...second.inquiries].map((value) => value.id)),
  ).toEqual(ids);
});
