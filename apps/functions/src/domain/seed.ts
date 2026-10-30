import { createHash } from 'node:crypto';
export function mergeIdentity(
  sessionId: string,
  boards: readonly { id: string; version: number }[],
): { seed: number; boardId: string } {
  const ordered = [...boards].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, ordered]))
    .digest();
  return {
    seed: digest.readUInt32BE(0),
    boardId: `b_${digest.toString('hex')}`,
  };
}
