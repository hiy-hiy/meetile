import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { AdminModerationService } from '@puzzle-sns/functions/server/admin-moderation';
import { PhotoDeletionService } from '@puzzle-sns/functions/server/photo-deletion';
import { HeldReviewService } from '@puzzle-sns/functions/server/held-review';
import { InquiryService } from '@puzzle-sns/functions/server/inquiries';
import { PhotoStorage } from '@puzzle-sns/functions/server/photo-objects';
import { readAdminConfig } from './config';
import { assertRequestOrigin } from './http';

const lifetime = 60 * 60 * 1000;
export async function runtime(request: Request) {
  const config = readAdminConfig();
  assertRequestOrigin(request, config);
  if (config.mode === 'local') {
    const probe = randomUUID();
    const response = await fetch(
      `http://127.0.0.1:15001/demo-puzzle-sns-local/asia-northeast1/localHealth?probe=${probe}`,
      { cache: 'no-store', signal: AbortSignal.timeout(4000) },
    );
    const body: unknown = await response.json();
    if (
      !response.ok ||
      !body ||
      typeof body !== 'object' ||
      !('runId' in body) ||
      body.runId !== config.runId ||
      !('probe' in body) ||
      body.probe !== probe
    )
      throw new Error('Local runtime unavailable');
  }
  const app =
    getApps().find((app) => app.name === 'puzzle-admin') ??
    initializeApp({ projectId: config.projectId }, 'puzzle-admin');
  if (app.options.projectId !== config.projectId)
    throw new Error('Admin configuration unavailable');
  const db = getFirestore(app),
    auth = getAuth(app);
  const service = new AdminModerationService(db);
  const held = new HeldReviewService(
    db,
    new PhotoStorage(getStorage(app).bucket(config.bucket)),
  );
  const cookieName =
    config.mode === 'cloud' ? '__Host-puzzle-admin' : 'puzzle-admin-local';
  function google(token: DecodedIdToken) {
    if (
      token.firebase.sign_in_provider !== 'google.com' ||
      token.email_verified !== true
    )
      throw new Error('Operator authentication required');
  }
  const cookieValue = request.headers
    .get('cookie')
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  const sessionHash = cookieValue
    ? createHash('sha256').update(cookieValue).digest('hex')
    : '';
  async function operator(): Promise<string> {
    const value = cookieValue;
    if (!value || value.length > 8192)
      throw new Error('Operator authentication required');
    const parts = value.split('~');
    if (parts.length !== 2 || !parts[0] || !parts[1])
      throw new Error('Operator authentication required');
    const token = await auth.verifySessionCookie(parts[0], true);
    google(token);
    // Every data operation also rechecks this allowlist in its own transaction.
    const [allowed, session] = await Promise.all([
      db.doc(`adminOperators/${token.uid}`).get(),
      db.doc(`adminSessions/${sessionHash}`).get(),
    ]);
    if (
      !session.exists ||
      session.get('uid') !== token.uid ||
      session.get('runId') !== config.runId ||
      !(Number(session.get('expiresAtMs')) > Date.now())
    )
      throw new Error('Operator authentication required');
    if (!allowed.exists || allowed.get('enabled') !== true)
      throw new Error('Operator authentication required');
    return token.uid;
  }
  function cookie(value: string, maxAge: number): string {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.mode === 'cloud' ? '; Secure' : ''}`;
  }
  return {
    config,
    service,
    held,
    inquiries: new InquiryService(db),
    auth,
    cookie,
    operator,
    async login(idToken: string) {
      const token = await auth.verifyIdToken(idToken, true);
      google(token);
      const age = Math.floor(Date.now() / 1000) - token.auth_time;
      if (age < 0 || age > 300)
        throw new Error('Recent authentication required');
      const value =
        (await auth.createSessionCookie(idToken, { expiresIn: lifetime })) +
        '~' +
        randomUUID();
      await service.beginSession(
        token.uid,
        createHash('sha256').update(value).digest('hex'),
        Date.now() + lifetime,
        config.runId,
      );
      return cookie(value, lifetime / 1000);
    },
    async logout(uid: string) {
      await service.endSession(uid, sessionHash);
    },
    async image(path: string) {
      if (
        !/^normalized\/[A-Za-z0-9_-]{1,128}\/image$/.test(path) &&
        !/^review\/[0-9a-f-]{36}\/image$/.test(path)
      )
        throw new Error('Image unavailable');
      const file = getStorage(app).bucket(config.bucket).file(path);
      const [meta] = await file.getMetadata();
      if (
        !Number.isFinite(Number(meta.size)) ||
        Number(meta.size) <= 0 ||
        Number(meta.size) > 5 * 1024 * 1024 ||
        meta.contentType !== 'image/jpeg'
      )
        throw new Error('Image unavailable');
      const [bytes] = await file.download();
      return bytes;
    },
    async cleanup() {
      await new PhotoDeletionService(db, {
        async remove(path) {
          await getStorage(app)
            .bucket(config.bucket)
            .file(path)
            .delete({ ignoreNotFound: true });
        },
      }).cleanup();
    },
  };
}
