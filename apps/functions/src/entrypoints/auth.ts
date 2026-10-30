import { ServiceError } from '../domain/errors';
export interface Caller {
  auth?: { uid: string; token: { firebase?: { sign_in_provider?: string } } };
  app?: { appId: string };
}
export function requireCaller(request: Caller): string {
  if (
    !request.auth ||
    request.auth.token.firebase?.sign_in_provider !== 'anonymous'
  )
    throw new ServiceError('unauthenticated');
  if (!request.app?.appId) throw new ServiceError('permission-denied');
  return request.auth.uid;
}
