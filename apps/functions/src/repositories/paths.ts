import { createHash } from 'node:crypto';
import { documentIdSchema, dayKeySchema } from '@puzzle-sns/contracts';

function identity(uid: string): string {
  if (!uid || uid.length > 128 || uid.includes('/'))
    throw new RangeError('Invalid internal identity');
  return uid;
}
export const paths = {
  clientState: (uid: string) => `clientState/${identity(uid)}`,
  subject: (uid: string) => `subjects/${identity(uid)}`,
  termination: (uid: string) => `accountTerminations/${identity(uid)}`,
  daily: (day: string, uid: string) =>
    `days/${dayKeySchema.parse(day)}/members/${identity(uid)}`,
  board: (id: string) => `boards/${documentIdSchema.parse(id)}`,
  piece: (id: string) => `pieces/${documentIdSchema.parse(id)}`,
  approval: (id: string) => `approvals/${documentIdSchema.parse(id)}`,
  session: (id: string) => `fitSessions/${documentIdSchema.parse(id)}`,
  fitView: (uid: string) => `fitViews/${identity(uid)}`,
  rateLimit: (uid: string) => `rateLimits/${identity(uid)}`,
  proximityToken: (hash: string) =>
    `proximityTokens/${documentIdSchema.parse(hash)}`,
  views: (uid: string) => `views/${identity(uid)}/boards`,
  view: (uid: string, id: string) =>
    `views/${identity(uid)}/boards/${documentIdSchema.parse(id)}`,
  grant: (uid: string, id: string) =>
    `viewGrants/${identity(uid)}/boards/${documentIdSchema.parse(id)}`,
  media: (id: string) => `mediaAccess/${documentIdSchema.parse(id)}`,
  hidden: (uid: string, id: string) =>
    `hidden/${identity(uid)}/pieces/${documentIdSchema.parse(id)}`,
  report: (uid: string, id: string) =>
    `reports/${createHash('sha256')
      .update(JSON.stringify([identity(uid), documentIdSchema.parse(id)]))
      .digest('hex')}`,
  block: (a: string, b: string) =>
    `blocks/${createHash('sha256')
      .update(JSON.stringify([identity(a), identity(b)].sort()))
      .digest('hex')}`,
};
