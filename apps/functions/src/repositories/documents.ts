import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { ServiceError } from '../domain/errors';

export async function readModel<T>(
  db: Firestore,
  tx: Transaction,
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const snapshot = await tx.get(db.doc(path));
  if (!snapshot.exists) throw new ServiceError('failed-precondition');
  return schema.parse(snapshot.data());
}
