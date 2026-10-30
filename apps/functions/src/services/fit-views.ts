import {
  Timestamp,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { fitViewSchema, type FitView } from '@puzzle-sns/contracts';
import { paths } from '../repositories/paths';

type Progress = Omit<FitView, 'sessionId'>;
/** Owner-readable FIT progress. Holds no counterpart ID; expires with the session (TTL). */
export function writeFitViews(
  db: Firestore,
  tx: Transaction,
  participants: readonly string[],
  sessionId: string,
  expiresAtMs: number,
  progress: Partial<Progress> & Pick<Progress, 'stage'>,
): void {
  const view = fitViewSchema.parse({
    sessionId,
    reason: null,
    boardId: null,
    boardChanged: false,
    ...progress,
  });
  for (const uid of participants)
    tx.set(db.doc(paths.fitView(uid)), {
      ...view,
      expireAt: Timestamp.fromMillis(expiresAtMs),
    });
}
