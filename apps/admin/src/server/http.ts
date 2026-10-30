import type { AdminConfig } from './config';
export function assertRequestOrigin(
  request: Request,
  config: AdminConfig,
): void {
  const expected = new URL(config.origin);
  if (
    request.headers.get('host') !== expected.host ||
    // Next may construct Request.url with its internal localhost origin.
    // Pin the actual HTTP Host; mutations independently pin the browser Origin.
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new Error('Request refused');
  if (
    request.method !== 'GET' &&
    (request.headers.get('origin') !== config.origin ||
      request.headers.get('x-puzzle-admin') !== '1')
  )
    throw new Error('Request refused');
}
export async function readJson(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new Error('Request refused');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request refused');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      throw new Error('Request refused');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: privateHeaders });
}
