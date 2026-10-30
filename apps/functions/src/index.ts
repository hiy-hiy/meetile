import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  onCall,
  HttpsError,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import { defineInt, defineString } from 'firebase-functions/params';
import { ZodError, type z } from 'zod';
import {
  emptyRequestSchema,
  boardRequestSchema,
  fitRequestSchema,
  reportProximityRequestSchema,
  captureRequestSchema,
  submitCaptureSchema,
  uploadCaptureSchema,
  onboardingSchema,
  deleteOwnPhotoSchema,
  reportPhotoSchema,
  blockPhotoSchema,
  endUseSchema,
} from '@puzzle-sns/contracts';
import { ServiceError } from './domain/errors';
import { requireCaller } from './entrypoints/auth';
import { Backend } from './services/backend';
import { CaptureService } from './services/capture';
import { FitService } from './services/fit';
import { GooglePhotoProcessor } from './services/photo-processor';
import { moderationPolicySchema } from './domain/moderation';
import { PhotoDeletionService } from './services/photo-deletion';
import { PhotoStorage } from './services/photo-storage';
import { ReportingService } from './services/reporting';
import { SafetyFoundation } from './services/safety';
import {
  AccountTerminationService,
  FirebasePrincipals,
} from './services/account-termination';

initializeApp();
const backend = new Backend(getFirestore());
const expectedProject = defineString('PUZZLE_PROJECT_ID');
const maxInstances = defineInt('PUZZLE_MAX_INSTANCES');
const bucketName = defineString('PUZZLE_STORAGE_BUCKET');
const moderationPolicy = defineString('PUZZLE_MODERATION_POLICY');
const legalVersion = defineString('PUZZLE_LEGAL_VERSION');
const options = {
  region: 'asia-northeast1',
  enforceAppCheck: true,
  maxInstances,
  minInstances: 0,
  memory: '512MiB',
  timeoutSeconds: 180,
  concurrency: 1,
} as const;
function captures(): CaptureService {
  return new CaptureService(
    getFirestore(),
    new GooglePhotoProcessor(
      getStorage().bucket(bucketName.value()),
      moderationPolicySchema.parse(JSON.parse(moderationPolicy.value())),
    ),
    legalVersion.value(),
  );
}
function fits(): FitService {
  return new FitService(
    getFirestore(),
    new PhotoStorage(getStorage().bucket(bucketName.value())),
  );
}
function deletions(): PhotoDeletionService {
  return new PhotoDeletionService(
    getFirestore(),
    new PhotoStorage(getStorage().bucket(bucketName.value())),
  );
}
function terminations(): AccountTerminationService {
  return new AccountTerminationService(
    getFirestore(),
    new PhotoStorage(getStorage().bucket(bucketName.value())),
    new FirebasePrincipals(getAuth()),
  );
}

function assertProject(): void {
  if (
    !process.env.GCLOUD_PROJECT ||
    expectedProject.value() !== process.env.GCLOUD_PROJECT
  )
    throw new ServiceError('permission-denied');
}

function callable<T, R>(
  schema: z.ZodType<T>,
  operation: (uid: string, data: T) => Promise<R>,
) {
  return onCall(
    options,
    async (request: CallableRequest<unknown>): Promise<R> => {
      try {
        assertProject();
        const uid = requireCaller(request);
        return await operation(uid, schema.parse(request.data));
      } catch (error: unknown) {
        if (error instanceof ServiceError)
          throw new HttpsError(error.code, error.code);
        if (error instanceof ZodError)
          throw new HttpsError('invalid-argument', 'invalid-argument');
        // Do not pass Firestore errors, request bodies or private model paths to logs/clients.
        throw new HttpsError('internal', 'internal');
      }
    },
  );
}
export const getDayState = callable(emptyRequestSchema, (uid) =>
  backend.getDayState(uid),
);
export const syncBoardView = callable(boardRequestSchema, (uid, data) =>
  backend.syncBoardView(uid, data.boardId),
);
export const listGallery = callable(emptyRequestSchema, (uid) =>
  backend.listGallery(uid),
);
export const confirmFit = callable(fitRequestSchema, (uid, data) =>
  backend.confirmFit(uid, data.sessionId),
);
export const beginFitScan = callable(emptyRequestSchema, (uid) =>
  fits().beginFitScan(uid),
);
// `method` is validated only; per-method daily counts are a Phase 7 aggregate.
export const reportProximity = callable(
  reportProximityRequestSchema,
  (uid, data) => fits().reportProximity(uid, data.token, data.peerToken),
);
export const getFitPreview = callable(fitRequestSchema, (uid, data) =>
  fits().getFitPreview(uid, data.sessionId),
);
export const leaveFit = callable(fitRequestSchema, (uid, data) =>
  fits().leaveFit(uid, data.sessionId),
);
export const beginCapture = callable(emptyRequestSchema, (uid) =>
  captures().begin(uid),
);
export const acceptOnboarding = callable(onboardingSchema, (uid, data) =>
  captures().acceptOnboarding(uid, data),
);
export const getCapture = callable(captureRequestSchema, (uid, data) =>
  captures().get(uid, data.captureId),
);
export const uploadCapture = callable(uploadCaptureSchema, (uid, data) =>
  captures().upload(uid, data),
);
export const submitCapture = callable(submitCaptureSchema, (uid, data) =>
  captures().submit(uid, data),
);
export const deleteOwnPhoto = callable(deleteOwnPhotoSchema, (uid, data) =>
  deletions().removeOwn(uid, data.pieceId),
);
export const reportPhoto = callable(reportPhotoSchema, (uid, data) =>
  new ReportingService(getFirestore()).report(uid, data),
);
export const blockPhoto = callable(blockPhotoSchema, (uid, data) =>
  new SafetyFoundation(getFirestore()).blockPhoto(uid, data),
);
export const endUse = callable(endUseSchema, (uid, data) =>
  terminations().end(uid, data),
);
export const cleanupDeletedPhotos = onSchedule(
  {
    region: options.region,
    maxInstances,
    minInstances: 0,
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Tokyo',
  },
  async () => {
    assertProject();
    await deletions().cleanup();
  },
);
export const cleanupCaptures = onSchedule(
  {
    region: options.region,
    maxInstances,
    minInstances: 0,
    schedule: 'every 60 minutes',
    timeZone: 'Asia/Tokyo',
  },
  async () => {
    assertProject();
    await captures().cleanupExpired();
  },
);
export const processAccountTerminations = onSchedule(
  {
    region: options.region,
    maxInstances,
    minInstances: 0,
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Tokyo',
    timeoutSeconds: 180,
  },
  async () => {
    assertProject();
    await terminations().resume();
  },
);
