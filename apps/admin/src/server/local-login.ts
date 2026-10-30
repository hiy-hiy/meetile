import 'server-only';
import type { AdminConfig } from './config';

/** Synthetic Google identity accepted only by the fixed loopback Auth Emulator. */
export async function localIdToken(config: AdminConfig): Promise<string> {
  if (
    config.mode !== 'local' ||
    config.projectId !== 'demo-puzzle-sns-local' ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:19099'
  )
    throw new Error('Local authentication unavailable');
  const now = Math.floor(Date.now() / 1000);
  const token =
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    ) +
    '.' +
    Buffer.from(
      JSON.stringify({
        sub: 'puzzle-sns-local-operator',
        email: 'operator@example.invalid',
        email_verified: true,
        iss: 'https://accounts.google.com',
        aud: 'synthetic-client',
        iat: now,
        exp: now + 3600,
      }),
    ).toString('base64url') +
    '.';
  const response = await fetch(
    'http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=emulator-only',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postBody: new URLSearchParams({
          id_token: token,
          providerId: 'google.com',
        }).toString(),
        requestUri: config.origin,
        returnSecureToken: true,
      }),
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    },
  );
  const value: unknown = await response.json();
  if (
    !response.ok ||
    !value ||
    typeof value !== 'object' ||
    !('idToken' in value) ||
    typeof value.idToken !== 'string'
  )
    throw new Error('Local authentication unavailable');
  return value.idToken;
}
