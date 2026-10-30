/** JST minus four hours = UTC plus five hours. Always supplied by the server. */
export function dayKeyAt(serverTimeMs: number): string {
  if (!Number.isSafeInteger(serverTimeMs) || serverTimeMs < 0)
    throw new RangeError('Invalid server time');
  return new Date(serverTimeMs + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
