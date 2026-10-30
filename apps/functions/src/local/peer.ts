import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Firestore } from 'firebase-admin/firestore';
import { assertLocalServer } from '../../../../tools/local-development/config';
import { Backend } from '../services/backend';
import { FitService } from '../services/fit';
import { PhotoStorage } from '../services/photo-storage';
import { dayKeyAt } from '../domain/time';
import { paths } from '../repositories/paths';

/**
 * Local-only artificial counterpart for one-device FIT screen checks. It is never imported by
 * the cloud entry point. It proves screen and server wiring, not distance detection.
 */
export class LocalPeer {
  constructor(
    private readonly db: Firestore,
    private readonly storage: PhotoStorage,
    private readonly backend: Backend,
    private readonly fit: FitService,
  ) {
    assertLocalServer(process.env);
  }
  /** Creates a synthetic person, then has them claim detection of the caller's token. */
  async appear(callerToken: string): Promise<{ peerToken: string }> {
    assertLocalServer(process.env);
    const uid = `local-peer-${randomUUID()}`;
    const pieceId = randomUUID();
    const approvalId = randomUUID();
    const dayKey = dayKeyAt(Date.now());
    await this.db.doc(paths.subject(uid)).create({
      status: 'active',
      accessEpoch: 0,
    });
    const image = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 214, g: 120, b: 90 },
      },
    })
      .jpeg()
      .toBuffer();
    await this.storage.save(`normalized/${pieceId}/image`, image);
    await this.db.doc(paths.approval(approvalId)).create({
      ownerUid: uid,
      dayKey,
      status: 'approved',
      normalizedPieceId: pieceId,
      username: '人工の相手',
      caption: '内部検証用の人工素材',
    });
    await this.backend.publishApprovedPiece(approvalId);
    const scan = await this.fit.beginFitScan(uid);
    await this.fit.reportProximity(uid, scan.token, callerToken);
    return { peerToken: scan.token };
  }
}
