import { z } from 'zod';
import { runtime as getRuntime } from '../../../server/runtime';
import { readJson, json, privateHeaders } from '../../../server/http';
import { localIdToken } from '../../../server/local-login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  try {
    const r = await getRuntime(request),
      uid = await r.operator();
    const params = new URL(request.url).searchParams;
    const operation = params.get('op');
    if (operation === 'session-check') {
      await r.service.access(uid, 'session-check');
      return json({ status: 'active' });
    }
    if (operation === 'list')
      return json(
        await r.service.list(uid, {
          status: params.get('status') ?? 'pending',
          ...(params.get('cursor') ? { cursor: params.get('cursor') } : {}),
        }),
      );
    if (operation === 'inquiry-list')
      return json(
        await r.inquiries.list(uid, {
          status: params.get('status') ?? 'active',
          ...(params.get('cursor') ? { cursor: params.get('cursor') } : {}),
        }),
      );
    if (operation === 'inquiry-detail')
      return json(
        await r.inquiries.detail(uid, z.string().parse(params.get('id'))),
      );
    if (operation === 'held-list')
      return json(
        await r.held.list(uid, {
          status: params.get('status') ?? 'pending',
          ...(params.get('cursor') ? { cursor: params.get('cursor') } : {}),
        }),
      );
    const caseId = z.string().parse(params.get('caseId'));
    if (operation === 'held-detail')
      return json(await r.held.detail(uid, caseId));
    if (operation === 'held-image') {
      const path = await r.held.imageTarget(uid, caseId);
      const bytes = await r.image(path);
      // An approval may have committed during the read; recheck before sending.
      await r.held.imageTarget(uid, caseId);
      return new Response(Uint8Array.from(bytes), {
        headers: {
          ...privateHeaders,
          'Content-Type': 'image/jpeg',
          'Content-Disposition': 'inline',
        },
      });
    }
    if (operation === 'detail')
      return json(await r.service.detail(uid, caseId));
    if (operation === 'image') {
      const path = await r.service.imageTarget(uid, caseId);
      const bytes = await r.image(path);
      // Recheck moderation/owner deletion after the storage read as well.
      await r.service.imageTarget(uid, caseId);
      return new Response(Uint8Array.from(bytes), {
        headers: {
          ...privateHeaders,
          'Content-Type': 'image/jpeg',
          'Content-Disposition': 'inline',
        },
      });
    }
    return json({ error: '操作できません。' }, 400);
  } catch {
    return json({ error: '認証・権限・接続状態を確認してください。' }, 403);
  }
}
export async function POST(request: Request): Promise<Response> {
  let r: Awaited<ReturnType<typeof getRuntime>> | undefined;
  let diagnosticStage = 'runtime';
  try {
    r = await getRuntime(request);
    diagnosticStage = 'json';
    const body = await readJson(request);
    const operation = new URL(request.url).searchParams.get('op');
    if (operation === 'session' || operation === 'local-session') {
      diagnosticStage = 'identity';
      const token =
        operation === 'local-session'
          ? (z.strictObject({}).parse(body), await localIdToken(r.config))
          : z.strictObject({ idToken: z.string().min(1).max(8192) }).parse(body)
              .idToken;
      diagnosticStage = 'session';
      const cookie = await r.login(token);
      return new Response(JSON.stringify({ status: 'signed-in' }), {
        headers: {
          ...privateHeaders,
          'Content-Type': 'application/json',
          'Set-Cookie': cookie,
        },
      });
    }
    const uid = await r.operator();
    if (operation === 'logout') {
      z.strictObject({}).parse(body);
      await r.logout(uid);
      return new Response(JSON.stringify({ status: 'signed-out' }), {
        headers: {
          ...privateHeaders,
          'Content-Type': 'application/json',
          'Set-Cookie': r.cookie('', 0),
        },
      });
    }
    if (operation === 'decision') {
      const result = await r.service.decide(uid, body);
      await r.cleanup();
      return json(result);
    }
    if (operation === 'suspend')
      return json(await r.service.suspend(uid, body));
    if (operation === 'inquiry-create')
      return json(await r.inquiries.create(uid, body));
    if (operation === 'inquiry-update')
      return json(await r.inquiries.update(uid, body));
    if (operation === 'rereview') {
      const result = await r.service.reReview(uid, body);
      if (result.effect === 'removed') await r.cleanup();
      return json(result);
    }
    if (operation === 'held-decision')
      return json(await r.held.decide(uid, body));
    return json({ error: '操作できません。' }, 400);
  } catch (error) {
    if (process.env.PUZZLE_ADMIN_MODE === 'local')
      console.warn('Local admin request rejected', {
        stage: diagnosticStage,
        name: error instanceof Error ? error.name : 'unknown',
        cause:
          error instanceof Error &&
          [
            'Request refused',
            'Admin configuration unavailable',
            'Local runtime unavailable',
            'Operator authentication required',
            'Recent authentication required',
          ].includes(error.message)
            ? error.message
            : 'other',
        code:
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (typeof error.code === 'number' ||
            (typeof error.code === 'string' &&
              [
                'permission-denied',
                'unauthenticated',
                'not-found',
                'failed-precondition',
                'invalid-argument',
                'auth/user-disabled',
                'auth/session-cookie-revoked',
                'auth/session-cookie-expired',
                'auth/id-token-revoked',
                'auth/id-token-expired',
              ].includes(error.code)))
            ? error.code
            : null,
      });
    const response = json(
      { error: '操作を完了できません。状態を再確認してお試しください。' },
      403,
    );
    if (new URL(request.url).searchParams.get('op') === 'logout' && r)
      response.headers.set('Set-Cookie', r.cookie('', 0));
    return response;
  }
}
