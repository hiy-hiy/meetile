import {
  onRequest,
  onCall,
  HttpsError,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { z, ZodError } from 'zod';
import {
  emptyRequestSchema,
  boardRequestSchema,
  captureRequestSchema,
  uploadCaptureSchema,
  submitCaptureSchema,
  deleteOwnPhotoSchema,
  reportPhotoSchema,
  blockPhotoSchema,
  endUseSchema,
  fitRequestSchema,
  fitTokenSchema,
  reportProximityRequestSchema,
} from '@puzzle-sns/contracts';
import { Backend } from './services/backend';
import { CaptureService } from './services/capture';
import { ServiceError } from './domain/errors';
import {
  assertLocalServer,
  LOCAL_PROJECT,
  LOCAL_REGION,
  LOCAL_TEST_VERSION,
  LOCAL_BUCKET,
  localAcknowledgementSchema,
} from '../../../tools/local-development/config';
import { LocalPhotoProcessor } from './local/photo-processor';
import { PhotoDeletionService } from './services/photo-deletion';
import { PhotoStorage } from './services/photo-storage';
import { FitService } from './services/fit';
import { LocalPeer } from './local/peer';
import { ReportingService } from './services/reporting';
import { SafetyFoundation } from './services/safety';
import {
  AccountTerminationService,
  FirebasePrincipals,
} from './services/account-termination';

// This entry point is never imported by the cloud entry point or cloud bundle.
export const localHealth = onRequest(
  { region: LOCAL_REGION, cors: false, maxInstances: 1 },
  (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      assertLocalServer(process.env);
    } catch {
      response.status(403).json({ error: 'local-environment-required' });
      return;
    }
    const probe = z.uuid().safeParse(request.query.probe);
    if (request.method !== 'GET' || !probe.success) {
      response.status(400).json({ error: 'invalid-probe' });
      return;
    }
    response.json({
      mode: 'local',
      projectId: LOCAL_PROJECT,
      protocol: 2,
      runId: process.env.PUZZLE_LOCAL_RUN_ID,
      probe: probe.data,
    });
    // Random per-request correlation only: no auth, device, photo, or safety identities.
    console.info(
      JSON.stringify({ event: 'local-connection', probe: probe.data }),
    );
  },
);

let services: {
  backend: Backend;
  captures: CaptureService;
  deletions: PhotoDeletionService;
  fit: FitService;
  peer: LocalPeer;
  reporting: ReportingService;
  safety: SafetyFoundation;
  terminations: AccountTerminationService;
} | null = null;
function localServices() {
  if (!services) {
    assertLocalServer(process.env);
    const app = initializeApp({ projectId: LOCAL_PROJECT }, 'local-session');
    const db = getFirestore(app);
    const storage = new PhotoStorage(getStorage(app).bucket(LOCAL_BUCKET));
    const backend = new Backend(db);
    const fit = new FitService(db, storage);
    services = {
      backend,
      fit,
      peer: new LocalPeer(db, storage, backend, fit),
      reporting: new ReportingService(db),
      safety: new SafetyFoundation(db),
      deletions: new PhotoDeletionService(db, storage),
      // assertLocalServer pins FIREBASE_AUTH_EMULATOR_HOST to loopback first.
      terminations: new AccountTerminationService(
        db,
        storage,
        new FirebasePrincipals(getAuth(app)),
      ),
      captures: new CaptureService(
        db,
        new LocalPhotoProcessor(getStorage(app).bucket(LOCAL_BUCKET), db),
        LOCAL_TEST_VERSION,
      ),
    };
  }
  return services;
}
function callable<T, R>(
  schema: z.ZodType<T>,
  operation: (uid: string, data: T) => Promise<R>,
) {
  return onCall(
    {
      region: LOCAL_REGION,
      enforceAppCheck: false,
      maxInstances: 1,
      timeoutSeconds: 180,
      memory: '512MiB',
      concurrency: 1,
    },
    async (request: CallableRequest<unknown>) => {
      try {
        assertLocalServer(process.env);
        const auth = request.auth;
        if (
          !auth ||
          auth.token.firebase.sign_in_provider !== 'anonymous' ||
          auth.token.aud !== LOCAL_PROJECT ||
          auth.token.iss !== `https://securetoken.google.com/${LOCAL_PROJECT}`
        )
          throw new ServiceError('unauthenticated');
        const payload = z
          .strictObject({ runId: z.uuid(), data: schema })
          .parse(request.data);
        if (payload.runId !== process.env.PUZZLE_LOCAL_RUN_ID)
          throw new ServiceError('failed-precondition');
        return await operation(auth.uid, payload.data);
      } catch (error: unknown) {
        if (error instanceof ServiceError)
          throw new HttpsError(error.code, error.code);
        if (error instanceof ZodError)
          throw new HttpsError('invalid-argument', 'invalid-argument');
        throw new HttpsError(
          'permission-denied',
          'local-environment-or-service-unavailable',
        );
      }
    },
  );
}
export const getDayState = callable(emptyRequestSchema, async (uid) => {
  // Scheduler does not run in the local suite. Connection/day polling retries
  // the same private deletion jobs; no maintenance endpoint is exposed.
  const services = localServices();
  await services.deletions.cleanup();
  await services.terminations.resume();
  return services.backend.getDayState(uid);
});
export const syncBoardView = callable(boardRequestSchema, (uid, data) =>
  localServices().backend.syncBoardView(uid, data.boardId),
);
export const listGallery = callable(emptyRequestSchema, (uid) =>
  localServices().backend.listGallery(uid),
);
export const acceptLocalTest = callable(
  localAcknowledgementSchema,
  (uid, data) => localServices().captures.acceptOnboarding(uid, data),
);
export const beginCapture = callable(emptyRequestSchema, (uid) =>
  localServices().captures.begin(uid),
);
export const getCapture = callable(captureRequestSchema, (uid, data) =>
  localServices().captures.get(uid, data.captureId),
);
export const uploadCapture = callable(uploadCaptureSchema, (uid, data) =>
  localServices().captures.upload(uid, data),
);
export const submitCapture = callable(submitCaptureSchema, (uid, data) =>
  localServices().captures.submit(uid, data),
);
export const deleteOwnPhoto = callable(deleteOwnPhotoSchema, (uid, data) =>
  localServices().deletions.removeOwn(uid, data.pieceId),
);
export const reportPhoto = callable(reportPhotoSchema, (uid, data) =>
  localServices().reporting.report(uid, data),
);
export const blockPhoto = callable(blockPhotoSchema, (uid, data) =>
  localServices().safety.blockPhoto(uid, data),
);
export const endUse = callable(endUseSchema, (uid, data) =>
  localServices().terminations.end(uid, data),
);
export const beginFitScan = callable(emptyRequestSchema, (uid) =>
  localServices().fit.beginFitScan(uid),
);
export const reportProximity = callable(
  reportProximityRequestSchema,
  (uid, data) =>
    localServices().fit.reportProximity(uid, data.token, data.peerToken),
);
export const getFitPreview = callable(fitRequestSchema, (uid, data) =>
  localServices().fit.getFitPreview(uid, data.sessionId),
);
export const leaveFit = callable(fitRequestSchema, (uid, data) =>
  localServices().fit.leaveFit(uid, data.sessionId),
);
export const confirmFit = callable(fitRequestSchema, (uid, data) =>
  localServices().backend.confirmFit(uid, data.sessionId),
);
// Local-only: a synthetic counterpart for one-device screen checks.
export const simulatePeer = callable(
  z.strictObject({ token: fitTokenSchema }),
  (_uid, data) => localServices().peer.appear(data.token),
);
