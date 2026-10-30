import Constants from 'expo-constants';
import { requireNativeModule } from 'expo-modules-core';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import {
  CryptoDigestAlgorithm,
  digestStringAsync,
  randomUUID,
} from 'expo-crypto';
import { z } from 'zod';
import { getApp } from '@react-native-firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
  signOut,
  getIdToken,
} from '@react-native-firebase/auth';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  doc,
  onSnapshot,
} from '@react-native-firebase/firestore';
import {
  getFunctions,
  connectFunctionsEmulator,
} from '@react-native-firebase/functions';
import {
  getStorage,
  connectStorageEmulator,
} from '@react-native-firebase/storage';
import {
  signatureSchema,
  documentIdSchema,
  captionSchema,
  boardViewSchema,
  reportPhotoSchema,
  blockPhotoSchema,
} from '@puzzle-sns/contracts';
import type { MobilePort, OwnPreferences } from '../controller';
import { fitViewData } from '../fit/view';
import {
  localDeviceSchema,
  localHealthSchema,
  localAcknowledgementSchema,
  LOCAL_PORTS,
  LOCAL_REGION,
  LOCAL_TEST_VERSION,
  LOCAL_PROJECT,
  LOCAL_BUCKET,
} from '../../../../tools/local-development/config';
import { probeAddress, verifyProbe } from './probe';
import { eraseOwnData } from '../installation';
import { galleryDirectory } from '../gallery/store';

export const LOCAL_GALLERY = 'local-gallery';

const KEY = 'local-test-state';
const preferencesSchema = z.strictObject({
  username: signatureSchema,
  legalVersion: z.literal(LOCAL_TEST_VERSION).nullable(),
  captureId: documentIdSchema.nullable(),
  draft: z
    .strictObject({
      captureId: documentIdSchema,
      username: signatureSchema,
      caption: captionSchema,
    })
    .nullable(),
  pendingReports: z.array(reportPhotoSchema).optional(),
  pendingBlocks: z.array(blockPhotoSchema).optional(),
});
const savedSchema = z.strictObject({
  runId: z.uuid(),
  uid: z.string().min(1),
  preferences: preferencesSchema,
});
type Saved = z.infer<typeof savedSchema>;
const blank = (): OwnPreferences => ({
  username: '',
  legalVersion: null,
  captureId: null,
  draft: null,
});
let prepared: {
  auth: ReturnType<typeof getAuth>;
  firestore: ReturnType<typeof initializeFirestore>;
  host: string;
} | null = null;

export function localPort(): MobilePort {
  let current: Saved | null = null;
  let initialization: Promise<OwnPreferences> | null = null;
  const imageDirectory = () =>
    new Directory(Paths.cache, 'local-private-images');
  const configuration = () => {
    const installation = requireNativeModule<{
      localBuildEnabled(): boolean;
      needsReset(): Promise<boolean>;
      commit(): Promise<void>;
    }>('Installation');
    if (!installation.localBuildEnabled() || !__DEV__)
      throw new Error('Local Debug binary required');
    const settings = localDeviceSchema.parse(
      Constants.expoConfig?.extra?.localRuntime,
    );
    const app = getApp();
    // Validate the native registration before constructing any service or request.
    probeAddress(settings, true, __DEV__, app.options.projectId, randomUUID());
    return { installation, settings, app };
  };
  const health = async () => {
    const { settings, app } = configuration();
    const probe = randomUUID();
    const address = probeAddress(
      settings,
      true,
      __DEV__,
      app.options.projectId,
      probe,
    );
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const response = await fetch(address, {
        signal: abort.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Local server unavailable');
      const body: unknown = await response.json();
      verifyProbe(body, probe);
      return localHealthSchema.parse(body);
    } finally {
      clearTimeout(timeout);
    }
  };
  const save = async (record: Saved) => {
    await SecureStore.setItemAsync(
      KEY,
      JSON.stringify(savedSchema.parse(record)),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  };
  const session = () => {
    const { settings } = configuration();
    if (!current || !prepared || prepared.host !== settings.host)
      throw new Error('Local session unavailable');
    const user = prepared.auth.currentUser;
    if (!user?.isAnonymous || user.uid !== current.uid)
      throw new Error('Local anonymous identity changed');
    return {
      ...prepared,
      runId: current.runId,
      uid: current.uid,
    };
  };
  const observe = (
    path: string,
    changed: (value: unknown) => void,
    failed: () => void,
  ) => {
    const initial = session();
    let active = true;
    const unsubscribe = onSnapshot(
      doc(initial.firestore, path),
      (snapshot) => {
        if (!active || snapshot.metadata.fromCache) return;
        try {
          const latest = session();
          if (latest.runId !== initial.runId || latest.uid !== initial.uid)
            throw new Error('Local session changed');
          changed(snapshot.data());
        } catch {
          failed();
        }
      },
      () => {
        if (active) failed();
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  };
  const boot = async (): Promise<OwnPreferences> => {
    let stage = 'native-configuration';
    try {
      const { settings, app, installation } = configuration();
      if (!prepared) {
        const auth = getAuth(app);
        connectAuthEmulator(
          auth,
          `http://${settings.host}:${LOCAL_PORTS.auth}`,
          {
            disableWarnings: true,
          },
        );
        const firestore = initializeFirestore(app, { persistence: false });
        connectFirestoreEmulator(
          firestore,
          settings.host,
          LOCAL_PORTS.firestore,
        );
        const storage = getStorage(app);
        connectStorageEmulator(storage, settings.host, LOCAL_PORTS.storage);
        connectFunctionsEmulator(
          getFunctions(app, LOCAL_REGION),
          settings.host,
          LOCAL_PORTS.functions,
        );
        prepared = { auth, firestore, host: settings.host };
      }
      if (prepared.host !== settings.host)
        throw new Error('Restart the native app after host changes');
      stage = 'health';
      const { runId } = await health();
      const { auth } = prepared;
      stage = 'auth-restoration';
      await auth.authStateReady();
      stage = 'local-preferences';
      const raw = await SecureStore.getItemAsync(KEY);
      let saved: Saved | null = null;
      if (raw) {
        try {
          saved = savedSchema.parse(JSON.parse(raw));
        } catch {
          /* Clear corrupt local-only preferences below. */
        }
      }
      const directory = imageDirectory();
      if (directory.exists) directory.delete();
      stage = 'installation-reset';
      if (
        (await installation.needsReset()) ||
        !saved ||
        saved.runId !== runId ||
        saved.uid !== auth.currentUser?.uid
      ) {
        if (auth.currentUser) {
          try {
            await signOut(auth);
          } catch (error: unknown) {
            if (
              typeof error !== 'object' ||
              error === null ||
              !('code' in error) ||
              error.code !== 'auth/no-current-user'
            )
              throw error;
          }
        }
        await SecureStore.deleteItemAsync(KEY);
        await installation.commit();
        saved = null;
      }
      stage = 'anonymous-sign-in';
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
      if (!user.isAnonymous)
        throw new Error('Anonymous emulator user required');
      stage = 'auth-token';
      await getIdToken(user, true);
      const record =
        saved ??
        savedSchema.parse({ runId, uid: user.uid, preferences: blank() });
      stage = 'save-preferences';
      await save(record);
      current = record;
      return record.preferences;
    } catch (error: unknown) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^(auth|firestore|storage|functions)\/[a-z-]{1,80}$/.test(error.code)
          ? error.code
          : 'unavailable';
      // Stage and validated SDK error category only; never tokens, UID, or messages.
      console.warn('Local initialization failed', { stage, code });
      throw error;
    }
  };
  return {
    initialize: () => {
      initialization ??= boot().finally(() => {
        initialization = null;
      });
      return initialization;
    },
    galleryOwner: async () => {
      try {
        const { runId, uid } = session();
        // A local reset starts a new identity; the hash keeps the raw ID out of the gallery DB.
        return await digestStringAsync(
          CryptoDigestAlgorithm.SHA256,
          `${runId}:${uid}`,
        );
      } catch {
        return null;
      }
    },
    checkConnection: async () => {
      const initial = session();
      if ((await health()).runId !== initial.runId)
        throw new Error('Local environment changed; reconnect');
    },
    eraseOwnData: async () => {
      current = null;
      initialization = null;
      await eraseOwnData({
        removeSecureData: () => SecureStore.deleteItemAsync(KEY),
        purgeImages: () => {
          const directory = imageDirectory();
          if (directory.exists) directory.delete();
          const gallery = galleryDirectory(LOCAL_GALLERY);
          if (gallery.exists) gallery.delete();
        },
        signOut: async () => {
          if (!prepared?.auth.currentUser) return;
          try {
            await signOut(prepared.auth);
          } catch (error: unknown) {
            if (
              typeof error !== 'object' ||
              error === null ||
              !('code' in error) ||
              error.code !== 'auth/no-current-user'
            )
              throw error;
          }
        },
      });
    },
    savePreferences: async (value) => {
      if (!current) throw new Error('Not initialized');
      const record = savedSchema.parse({ ...current, preferences: value });
      await save(record);
      current = record;
    },
    call: async (name, data) => {
      if (!current || !prepared) throw new Error('Not initialized');
      const routes: Record<string, string> = {
        getDayState: 'getDayState',
        acceptOnboarding: 'acceptLocalTest',
        beginCapture: 'beginCapture',
        getCapture: 'getCapture',
        uploadCapture: 'uploadCapture',
        submitCapture: 'submitCapture',
        syncBoardView: 'syncBoardView',
        listGallery: 'listGallery',
        deleteOwnPhoto: 'deleteOwnPhoto',
        reportPhoto: 'reportPhoto',
        blockPhoto: 'blockPhoto',
        endUse: 'endUse',
        beginFitScan: 'beginFitScan',
        reportProximity: 'reportProximity',
        getFitPreview: 'getFitPreview',
        leaveFit: 'leaveFit',
        confirmFit: 'confirmFit',
        simulatePeer: 'simulatePeer',
      };
      const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
      if (!route) throw new Error('This operation is unavailable in step 4');
      if (name === 'acceptOnboarding') localAcknowledgementSchema.parse(data);
      if ((await health()).runId !== current.runId)
        throw new Error('Local environment changed; reconnect');
      const user = prepared.auth.currentUser;
      if (!user?.isAnonymous || user.uid !== current.uid)
        throw new Error('Local anonymous identity changed');
      const token = await getIdToken(user);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 180000);
      try {
        // Keep the native Auth token explicit: iOS Functions/Auth interop did
        // not attach it in the local binary. No App Check token is fabricated.
        const response = await fetch(
          `http://${prepared.host}:${LOCAL_PORTS.functions}/${LOCAL_PROJECT}/${LOCAL_REGION}/${route}`,
          {
            method: 'POST',
            signal: abort.signal,
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ data: { runId: current.runId, data } }),
          },
        );
        if (!response.ok) {
          console.warn('Local request rejected', {
            operation: route,
            status: response.status,
          });
          throw new Error('Local request rejected');
        }
        return z
          .strictObject({ result: z.unknown() })
          .parse(await response.json()).result;
      } finally {
        clearTimeout(timeout);
      }
    },
    subscribeState: (changed, failed) => {
      let previous: string | null = null;
      return observe(
        `clientState/${session().uid}`,
        (value) => {
          if (!value) throw new Error('Local state unavailable');
          const next = JSON.stringify(value);
          if (previous !== null && previous !== next) changed();
          previous = next;
        },
        failed,
      );
    },
    subscribeFit: (changed, failed) =>
      observe(
        `fitViews/${session().uid}`,
        (value) => {
          if (value) changed(fitViewData(value));
        },
        failed,
      ),
    subscribeBoard: (boardId, changed, failed) =>
      observe(
        `views/${session().uid}/boards/${documentIdSchema.parse(boardId)}`,
        changed,
        failed,
      ),
    loadImages: async (value) => {
      const initial = session();
      const board = boardViewSchema.parse(value);
      if ((await health()).runId !== initial.runId)
        throw new Error('Local environment changed');
      const user = initial.auth.currentUser;
      if (!user) throw new Error('Local identity unavailable');
      const token = await getIdToken(user);
      const directory = imageDirectory();
      directory.create({ intermediates: true, idempotent: true });
      const batch = new Directory(directory, randomUUID());
      batch.create({ intermediates: true });
      const uris: Record<string, string> = {};
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 20000);
      try {
        const results = await Promise.allSettled(
          board.pieces
            .filter((piece) => piece.visibility === 'visible')
            .map(async (piece) => {
              if (!piece.photoRef) throw new Error('Missing image');
              const file = new File(batch, `${piece.id}.jpg`);
              // Send native Auth explicitly: the local iOS Storage SDK rejected
              // this identity. Storage Emulator still enforces the existing Rules.
              await File.downloadFileAsync(
                `http://${initial.host}:${LOCAL_PORTS.storage}/v0/b/${LOCAL_BUCKET}/o/${encodeURIComponent(piece.photoRef)}?alt=media`,
                file,
                {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: abort.signal,
                },
              );
              uris[piece.id] = file.uri;
            }),
        );
        const latest = session();
        const failure = results.find((result) => result.status === 'rejected');
        if (failure)
          throw new Error('Local image access unavailable', {
            cause: failure.reason,
          });
        if (latest.runId !== initial.runId || latest.uid !== initial.uid)
          throw new Error('Local image access unavailable');
        return {
          uris,
          release: () => {
            if (batch.exists) batch.delete();
          },
        };
      } catch (error) {
        if (batch.exists) batch.delete();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
