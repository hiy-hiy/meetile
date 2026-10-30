export type ErrorCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'failed-precondition'
  | 'not-found'
  | 'invalid-argument'
  | 'resource-exhausted';
export class ServiceError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'ServiceError';
  }
}
export function requireCondition(
  value: unknown,
  code: ErrorCode = 'failed-precondition',
): asserts value {
  if (!value) throw new ServiceError(code);
}
