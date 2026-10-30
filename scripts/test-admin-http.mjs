import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  adminLocalEnvironment,
  prepareLocalOperator,
  createAdminFixture,
  createHeldFixture,
  syntheticGoogleCredential,
} from './admin-fixture.mjs';
import {
  LOCAL_PROJECT,
  LOCAL_BUCKET,
  assertLocalServer,
} from '../tools/local-development/config.ts';

assertLocalServer({ ...process.env, FUNCTIONS_EMULATOR: 'true' });
if (!process.env.PUZZLE_LOCAL_VERIFY_FIXTURE)
  throw new Error('Admin HTTP test requires isolated local verification mode');
const environment = adminLocalEnvironment(process.env.PUZZLE_LOCAL_RUN_ID);
const app = initializeApp(
  {
    projectId: LOCAL_PROJECT,
  },
  randomUUID(),
);
const db = getFirestore(app),
  auth = getAuth(app);
const operator = await prepareLocalOperator(app);
const [removeCase, dismissCase] = await Promise.all(
  ['A', 'B'].map((label) => createAdminFixture(app, label)),
);
const [approveHeld, rejectHeld] = await Promise.all(
  ['A', 'B'].map((label) => createHeldFixture(app, label)),
);
const serverLog = createWriteStream(
  '.tools/local-runtime/phase4-admin-http-server.log',
  { flags: 'w', mode: 0o600 },
);
const next = createRequire(resolve('apps/admin/package.json')).resolve(
  'next/dist/bin/next',
);
const child = spawn(
  process.execPath,
  [next, 'start', '--hostname', '127.0.0.1', '--port', '3002'],
  {
    cwd: resolve('apps/admin'),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
child.stdout.pipe(serverLog);
child.stderr.pipe(serverLog);
const closed = new Promise((resolve) => child.once('exit', resolve));
let cookie = '';
async function request(op, body, options = {}) {
  const response = await fetch(`http://127.0.0.1:3002/api/admin?${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            Origin: 'http://127.0.0.1:3002',
            'X-Puzzle-Admin': '1',
          }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return response;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        'Admin server exited before verification; see the ignored local server log.',
      );
    try {
      const response = await fetch('http://127.0.0.1:3002', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) {
        ready = true;
        await response.arrayBuffer();
        break;
      }
    } catch {
      /* Wait for the owned Next server. */
    }
    await setTimeout(250);
  }
  assert.ok(ready, 'Admin server did not become ready');
  for (const op of [
    'op=list',
    `op=detail&caseId=${removeCase.caseId}`,
    `op=image&caseId=${removeCase.caseId}`,
    'op=held-list',
    `op=held-detail&caseId=${approveHeld.caseId}`,
    `op=held-image&caseId=${approveHeld.caseId}`,
  ])
    assert.equal((await request(op)).status, 403);
  assert.equal(
    (
      await request('op=decision', {
        caseId: removeCase.caseId,
        requestId: randomUUID(),
        decision: 'remove',
        note: '人工検証',
      })
    ).status,
    403,
  );
  const outsider = await syntheticGoogleCredential(
    'outsider-' + randomUUID(),
    'outsider@example.invalid',
  );
  assert.equal(
    (await request('op=session', { idToken: outsider.idToken })).status,
    403,
  );
  const anonymous = await (
    await fetch(
      'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    )
  ).json();
  await db.doc(`adminOperators/${anonymous.localId}`).set({ enabled: true });
  assert.equal(
    (await request('op=session', { idToken: anonymous.idToken })).status,
    403,
  );
  const login = await request('op=local-session', {});
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  const listed = await request('op=list');
  assert.equal(listed.status, 200);
  const list = await listed.json();
  assert.equal(list.reports.length, 2);
  const detailResponse = await request(`op=detail&caseId=${removeCase.caseId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.photoState, 'approved');
  const payload = JSON.stringify({ list, detail });
  for (const key of [
    'reporterUid',
    'ownerUid',
    'reviewerUid',
    'safetyId',
    operator.uid,
  ])
    assert.ok(!payload.includes(key));
  const image = await request(`op=image&caseId=${removeCase.caseId}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  await image.arrayBuffer();
  const action = {
    caseId: removeCase.caseId,
    requestId: randomUUID(),
    decision: 'remove',
    note: '人工図形による無地化の内部検証',
  };
  for (const headers of [
    { Origin: 'https://attacker.invalid' },
    { 'X-Puzzle-Admin': '' },
    { Host: 'attacker.invalid' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const status = await new Promise((resolveStatus, reject) => {
      const req = httpRequest(
        'http://127.0.0.1:3002/api/admin?op=decision',
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            Origin: 'http://127.0.0.1:3002',
            'X-Puzzle-Admin': '1',
            ...headers,
          },
          signal: AbortSignal.timeout(20000),
        },
        (response) => {
          response.resume();
          response.once('end', () => resolveStatus(response.statusCode));
        },
      );
      req.once('error', reject);
      req.end(JSON.stringify(action));
    });
    assert.notEqual(
      status,
      200,
      'Forged request must be rejected: ' + Object.keys(headers)[0],
    );
  }
  assert.equal(
    (await request('op=decision', { ...action, ownerUid: 'forged' })).status,
    403,
  );
  assert.equal(
    (await request('op=decision', { ...action, note: 'x'.repeat(9000) }))
      .status,
    403,
  );
  const before = (await db.doc(`boards/${removeCase.boardId}`).get()).data();
  for (const response of await Promise.all([
    request('op=decision', action),
    request('op=decision', action),
  ]))
    assert.equal(response.status, 200);
  assert.equal(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'remove-photo')
        .get()
    ).size,
    1,
  );
  assert.deepEqual(
    (await db.doc(`boards/${removeCase.boardId}`).get()).data(),
    before,
  );
  assert.equal(
    (await db.doc(`pieces/${removeCase.pieceId}`).get()).get('status'),
    'removed',
  );
  assert.equal(
    (
      await getStorage(app)
        .bucket(LOCAL_BUCKET)
        .file(`normalized/${removeCase.pieceId}/image`)
        .exists()
    )[0],
    false,
  );
  assert.equal(
    (await request(`op=image&caseId=${removeCase.caseId}`)).status,
    403,
  );
  assert.equal(
    (await request('op=decision', { ...action, note: '変更要求' })).status,
    403,
  );
  const dismissed = await request('op=decision', {
    caseId: dismissCase.caseId,
    requestId: randomUUID(),
    decision: 'dismiss',
    note: '人工図形として確認し対応不要',
  });
  assert.equal(dismissed.status, 200);
  assert.equal(
    (
      await getStorage(app)
        .bucket(LOCAL_BUCKET)
        .file(`normalized/${dismissCase.pieceId}/image`)
        .exists()
    )[0],
    true,
  );
  assert.equal((await (await request('op=list')).json()).reports.length, 0);
  const reviewed = await (await request('op=list&status=reviewed')).json();
  assert.equal(reviewed.reports.length, 2);
  assert.ok(!JSON.stringify(reviewed).includes('reviewerUid'));
  // Human review of held captures.
  const heldList = await (await request('op=held-list')).json();
  assert.deepEqual(
    heldList.items.map((item) => item.caseId).sort(),
    [approveHeld.caseId, rejectHeld.caseId].sort(),
  );
  const heldDetail = await (
    await request(`op=held-detail&caseId=${approveHeld.caseId}`)
  ).json();
  assert.equal(heldDetail.blocked, null);
  assert.equal(heldDetail.username, '保留テスト A');
  const heldPayload = JSON.stringify({ heldList, heldDetail });
  for (const value of [
    approveHeld.ownerUid,
    approveHeld.pieceId,
    'ownerUid',
    'imagePath',
    operator.uid,
  ])
    assert.ok(!heldPayload.includes(value));
  const heldImage = await request(`op=held-image&caseId=${approveHeld.caseId}`);
  assert.equal(heldImage.status, 200);
  assert.equal(heldImage.headers.get('content-type'), 'image/jpeg');
  await heldImage.arrayBuffer();
  const approval = {
    caseId: approveHeld.caseId,
    requestId: randomUUID(),
    decision: 'approve',
    note: '人工図形として確認し公開を許可',
  };
  assert.equal(
    (await request('op=held-decision', { ...approval, ownerUid: 'forged' }))
      .status,
    403,
  );
  assert.equal(
    (
      await request('op=held-decision', approval, {
        headers: { 'X-Puzzle-Admin': '' },
      })
    ).status,
    403,
  );
  for (const response of await Promise.all([
    request('op=held-decision', approval),
    request('op=held-decision', approval),
  ]))
    assert.ok([200, 403].includes(response.status));
  assert.equal((await request('op=held-decision', approval)).status, 200);
  assert.equal(
    (await db.doc(`pieces/${approveHeld.pieceId}`).get()).get('status'),
    'approved',
  );
  const bucket = getStorage(app).bucket(LOCAL_BUCKET);
  assert.equal(
    (await bucket.file(`normalized/${approveHeld.pieceId}/image`).exists())[0],
    true,
  );
  assert.equal(
    (await bucket.file(`review/${approveHeld.caseId}/image`).exists())[0],
    false,
  );
  assert.equal(
    (await request(`op=held-image&caseId=${approveHeld.caseId}`)).status,
    403,
  );
  assert.equal(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'approve-held')
        .get()
    ).size,
    1,
  );
  const withheld = await request('op=held-decision', {
    caseId: rejectHeld.caseId,
    requestId: randomUUID(),
    decision: 'reject',
    note: '人工図形として確認し公開しない',
  });
  assert.equal(withheld.status, 200);
  assert.equal(
    (await db.doc(`captures/${rejectHeld.caseId}`).get()).get('status'),
    'rejected',
  );
  assert.equal(
    (await bucket.file(`review/${rejectHeld.caseId}/image`).exists())[0],
    true,
  );
  assert.equal((await (await request('op=held-list')).json()).items.length, 0);
  const heldReviewed = await (
    await request('op=held-list&status=reviewed')
  ).json();
  assert.equal(heldReviewed.items.length, 2);
  assert.ok(!JSON.stringify(heldReviewed).includes('reviewerUid'));
  // A real anonymous credential must work before the stop; a custom-token
  // provider would be rejected independently and could falsely pass this test.
  async function anonymousActor() {
    const response = await fetch(
      'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  }
  const actor = await anonymousActor(),
    reporter = await anonymousActor();
  const suspensionCase = await createAdminFixture(app, 'C', {
    ownerUid: reporter.localId,
    targetUid: actor.localId,
  });
  const token = actor.idToken;
  async function mobile(name, data, credential = token) {
    return fetch(
      `http://127.0.0.1:15001/${LOCAL_PROJECT}/asia-northeast1/${name}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          data: { runId: process.env.PUZZLE_LOCAL_RUN_ID, data },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
  }
  async function media(credential = token) {
    const response = await fetch(
      `http://127.0.0.1:19199/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(`normalized/${suspensionCase.pieceId}/image`)}?alt=media`,
      {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    await response.arrayBuffer();
    return response.status;
  }
  async function board(credential = token) {
    const response = await fetch(
      `http://127.0.0.1:18080/v1/projects/${LOCAL_PROJECT}/databases/(default)/documents/views/${actor.localId}/boards/${suspensionCase.boardId}`,
      {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    await response.arrayBuffer();
    return response.status;
  }
  assert.equal((await mobile('getDayState', {})).status, 200);
  assert.equal(
    (await mobile('syncBoardView', { boardId: suspensionCase.boardId })).status,
    200,
  );
  assert.equal(await media(), 200);
  assert.equal(await board(), 200);
  const geometry = (
    await db.doc(`boards/${suspensionCase.boardId}`).get()
  ).data();
  const suspension = {
    caseId: suspensionCase.caseId,
    requestId: randomUUID(),
    note: '匿名認証を維持したまま停止する人工検証',
  };
  assert.equal(
    (await request('op=suspend', { ...suspension, ownerUid: reporter.localId }))
      .status,
    403,
  );
  assert.equal(
    (await request('op=suspend', { ...suspension, note: ' ' })).status,
    403,
  );
  assert.equal(
    (
      await request('op=suspend', suspension, {
        headers: { Origin: 'https://attacker.invalid' },
      })
    ).status,
    403,
  );
  assert.equal((await request('op=suspend', suspension)).status, 200);
  assert.equal((await request('op=suspend', suspension)).status, 200);
  assert.equal(
    (await request('op=suspend', { ...suspension, note: '変更' })).status,
    403,
  );
  for (const [name, data] of [
    ['getDayState', {}],
    ['syncBoardView', { boardId: suspensionCase.boardId }],
    ['beginCapture', {}],
    [
      'acceptLocalTest',
      { age16OrOlder: true, accepted: true, legalVersion: 'local-test-v1' },
    ],
  ])
    assert.equal(
      (await mobile(name, data)).status,
      403,
      `Suspended actor must not call ${name}`,
    );
  assert.equal(await media(), 403);
  assert.equal(await board(), 403);
  const refreshed = await fetch(
    'http://127.0.0.1:19099/securetoken.googleapis.com/v1/token?key=emulator-only',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: actor.refreshToken,
      }),
    },
  );
  assert.equal(refreshed.status, 200);
  const renewed = await refreshed.json();
  assert.equal(renewed.user_id, actor.localId);
  assert.equal((await mobile('getDayState', {}, renewed.id_token)).status, 403);
  assert.equal(await media(renewed.id_token), 403);
  assert.deepEqual(
    (await db.doc(`boards/${suspensionCase.boardId}`).get()).data(),
    geometry,
  );
  assert.equal(
    (await db.doc(`subjects/${reporter.localId}`).get()).get('status'),
    'active',
  );
  const stopped = await (
    await request(`op=detail&caseId=${suspensionCase.caseId}`)
  ).json();
  assert.equal(stopped.subjectState, 'suspended');
  assert.equal(stopped.suspension.note, suspension.note);
  assert.equal(stopped.photoState, 'approved');
  for (const privateValue of [
    actor.localId,
    reporter.localId,
    'ownerUid',
    'reporterUid',
    'accessEpoch',
  ])
    assert.ok(!JSON.stringify(stopped).includes(privateValue));
  assert.equal(
    (
      await db
        .collection('adminAudit')
        .where('action', '==', 'suspend-user')
        .get()
    ).size,
    1,
  );
  // Second operator (Google-provider path) for re-review and the ledger.
  const secondCredential = await syntheticGoogleCredential(
    'second-' + randomUUID(),
    'second@example.invalid',
  );
  const secondUid = (await auth.verifyIdToken(secondCredential.idToken)).uid;
  await db.doc(`adminOperators/${secondUid}`).set({ enabled: true });
  const secondLogin = await request('op=session', {
    idToken: secondCredential.idToken,
  });
  assert.equal(secondLogin.status, 200);
  const firstCookie = cookie;
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  async function as(value, action) {
    const previous = cookie;
    cookie = value;
    try {
      return await action();
    } finally {
      cookie = previous;
    }
  }
  // Re-review: never by the original operator; an overturned dismissal hides the photo.
  const reReview = (target, outcome, caseId, extra = {}) => ({
    caseId,
    requestId: randomUUID(),
    target,
    outcome,
    note: '人工図形の再確認の内部検証',
    ...extra,
  });
  assert.equal(
    (
      await request(
        'op=rereview',
        reReview('decision', 'overturned', dismissCase.caseId),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        'op=rereview',
        reReview('suspension', 'upheld', suspensionCase.caseId),
      )
    ).status,
    403,
  );
  const ownDetail = await (
    await request(`op=detail&caseId=${suspensionCase.caseId}`)
  ).json();
  assert.equal(ownDetail.ownSuspension, true);
  await as(secondCookie, async () => {
    const forged = reReview('decision', 'overturned', dismissCase.caseId, {
      reviewerUid: 'forged',
    });
    assert.equal((await request('op=rereview', forged)).status, 403);
    assert.equal(
      (
        await request('op=rereview', {
          ...forged,
          reviewerUid: undefined,
          note: ' ',
        })
      ).status,
      403,
    );
    const overturn = reReview('decision', 'overturned', dismissCase.caseId);
    const done = await request('op=rereview', overturn);
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), {
      status: 'recorded',
      effect: 'removed',
    });
    assert.equal((await request('op=rereview', overturn)).status, 200);
    assert.equal(
      (await request('op=rereview', { ...overturn, note: '変更' })).status,
      403,
    );
    assert.equal(
      (
        await request(
          'op=rereview',
          reReview('decision', 'upheld', dismissCase.caseId),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          'op=rereview',
          reReview('suspension', 'upheld', suspensionCase.caseId),
        )
      ).status,
      200,
    );
    const detail = await (
      await request(`op=detail&caseId=${dismissCase.caseId}`)
    ).json();
    assert.equal(detail.ownDecision, false);
    assert.equal(detail.reReviews.decision.effect, 'removed');
    assert.equal(detail.photoState, 'removed');
    for (const privateValue of [
      operator.uid,
      secondUid,
      'reviewerUid',
      'fingerprint',
      'operatorUid',
    ])
      assert.ok(!JSON.stringify(detail).includes(privateValue));
    assert.equal(
      (await request(`op=image&caseId=${dismissCase.caseId}`)).status,
      403,
    );
  });
  assert.equal(
    (await db.doc(`pieces/${dismissCase.pieceId}`).get()).get('status'),
    'removed',
  );
  assert.equal(
    (
      await getStorage(app)
        .bucket(LOCAL_BUCKET)
        .file(`normalized/${dismissCase.pieceId}/image`)
        .exists()
    )[0],
    false,
  );
  assert.equal(
    (await db.doc(`reports/${dismissCase.caseId}`).get()).get('decision'),
    'dismiss',
  );
  assert.equal(
    (await db.doc(`subjects/${actor.localId}`).get()).get('status'),
    'suspended',
  );
  // Inquiry ledger: no contact details, relative identities only, final once closed.
  const entry = {
    requestId: randomUUID(),
    category: 'deletion',
    externalRef: 'REQ-HTTP-1',
    summary: '端末を紛失したため写真の削除を希望（人工の検証）。',
  };
  assert.equal(
    (
      await request('op=inquiry-create', {
        ...entry,
        requestId: randomUUID(),
        summary: '連絡は taro@example.com へ',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('op=inquiry-create', { ...entry, ownerUid: 'forged' }))
      .status,
    403,
  );
  assert.equal(
    (
      await request('op=inquiry-create', entry, {
        headers: { Origin: 'https://attacker.invalid' },
      })
    ).status,
    403,
  );
  const created = await request('op=inquiry-create', entry);
  assert.equal(created.status, 200);
  const { id: inquiryId } = await created.json();
  assert.deepEqual(await (await request('op=inquiry-create', entry)).json(), {
    id: inquiryId,
  });
  assert.equal(
    (await db.collection('adminInquiries').get()).size,
    1,
    'A retried registration must create one entry',
  );
  const update = (body) =>
    request('op=inquiry-update', {
      id: inquiryId,
      requestId: randomUUID(),
      ...body,
    });
  assert.equal(
    (await as(secondCookie, () => update({ action: 'assign' }))).status,
    200,
  );
  assert.equal(
    (await update({ action: 'note', note: '外部窓口で確認中。' })).status,
    200,
  );
  assert.equal(
    (await update({ action: 'link', caseId: removeCase.caseId })).status,
    200,
  );
  const ledger = await (
    await request(`op=inquiry-detail&id=${inquiryId}`)
  ).json();
  const listing = await (await request('op=inquiry-list')).json();
  assert.equal(ledger.inquiry.assigned, true);
  assert.equal(ledger.inquiry.assignedToMe, false);
  assert.equal(ledger.inquiry.linkedCaseId, removeCase.caseId);
  assert.equal(ledger.notes[0].mine, true);
  assert.equal(listing.inquiries.length, 1);
  for (const privateValue of [
    operator.uid,
    secondUid,
    'createdBy',
    'assigneeUid',
    'authorUid',
    'fingerprint',
  ])
    assert.ok(!JSON.stringify({ ledger, listing }).includes(privateValue));
  assert.equal(
    (
      await update({
        action: 'close',
        resolution: 'unable-to-verify',
        note: '対象の写真を特定できなかった。',
      })
    ).status,
    200,
  );
  assert.equal(
    (await as(secondCookie, () => update({ action: 'note', note: '追記' })))
      .status,
    403,
  );
  assert.equal(
    (await (await request('op=inquiry-list')).json()).inquiries.length,
    0,
  );
  assert.equal(
    (await (await request('op=inquiry-list&status=closed')).json()).inquiries
      .length,
    1,
  );
  assert.equal(
    (await db.doc(`reports/${removeCase.caseId}`).get()).get('status'),
    'reviewed',
  );
  assert.equal(
    (await as(secondCookie, () => request('op=logout', {}))).status,
    200,
  );
  assert.equal(cookie, firstCookie);
  await db.doc(`adminOperators/${operator.uid}`).update({ enabled: false });
  assert.equal((await request('op=list')).status, 403);
  await db.doc(`adminOperators/${operator.uid}`).update({ enabled: true });
  await auth.updateUser(operator.uid, { disabled: true });
  assert.equal((await request('op=list')).status, 403);
  await auth.updateUser(operator.uid, { disabled: false });
  const oldCookie = cookie;
  const logout = await request('op=logout', {});
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('op=list')).status, 403);
  cookie = '';
  const second = await request('op=local-session', {});
  assert.equal(second.status, 200);
  const newCookie = second.headers.get('set-cookie').split(';')[0];
  assert.notEqual(oldCookie, newCookie);
  cookie = oldCookie;
  assert.equal((await request('op=list')).status, 403);
  cookie = newCookie;
  assert.equal((await request('op=list')).status, 200);
  await request('op=logout', {});
  await writeFile(
    '.tools/local-runtime/phase4-admin-http-result.json',
    JSON.stringify({
      suspensionWithExistingAndRefreshedAnonymousTokens: true,
      authorization: true,
      googleProviderRequired: true,
      originProtection: true,
      boundedBodies: true,
      privateDtos: true,
      privateImageProxy: true,
      atomicIdempotentRemoval: true,
      physicalDeletion: true,
      dismissalPreservesImage: true,
      allowlistRevocation: true,
      disabledOperatorDenied: true,
      logoutRevocation: true,
      noCookieReactivation: true,
      heldReview: true,
      reReviewByAnotherOperator: true,
      inquiryLedger: true,
    }) + '\n',
    { mode: 0o600 },
  );
  console.log(
    'Admin HTTP checks passed: Google-provider allowlist, private image proxy, origin/host/body checks, atomic decisions, physical deletion, disabled/revoked operators and non-reusable logout cookies.',
  );
} finally {
  child.kill('SIGTERM');
  await closed;
  serverLog.end();
  await deleteApp(app);
}
