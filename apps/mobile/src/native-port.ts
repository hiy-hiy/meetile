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
  signInAnonymously,
  signOut,
  connectAuthEmulator,
} from '@react-native-firebase/auth';
import {
  initializeAppCheck,
  ReactNativeFirebaseAppCheckProvider,
  getToken,
} from '@react-native-firebase/app-check';
import {
  getFirestore,
  doc,
  onSnapshot,
  initializeFirestore,
  connectFirestoreEmulator,
} from '@react-native-firebase/firestore';
import {
  getFunctions,
  httpsCallable,
  connectFunctionsEmulator,
} from '@react-native-firebase/functions';
import {
  getStorage,
  ref,
  writeToFile,
  connectStorageEmulator,
} from '@react-native-firebase/storage';
import {
  captionSchema,
  signatureSchema,
  documentIdSchema,
  reportPhotoSchema,
  blockPhotoSchema,
} from '@puzzle-sns/contracts';
import type { MobilePort, OwnPreferences } from './controller';
import { fitViewData } from './fit/view';
import { eraseOwnData, resetInstallation } from './installation';
import { galleryDirectory } from './gallery/store';

export const GALLERY = 'puzzle-gallery';

const preferencesSchema = z.strictObject({
  username: signatureSchema,
  legalVersion: z.string().nullable(),
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
// Bound to the anonymous UID: after account termination (or a failed erase)
// a new principal must never inherit consent state or pending safety input.
const savedSchema = z.strictObject({
  uid: z.string().min(1),
  preferences: preferencesSchema,
});
const blank = (): OwnPreferences => ({
  username: '',
  legalVersion: null,
  captureId: null,
  draft: null,
});
const legalSchema = z.strictObject({
  version: z.string().min(1),
  terms: z.url().startsWith('https://'),
  privacy: z.url().startsWith('https://'),
  community: z.url().startsWith('https://'),
});
const extraSchema = z.object({
  variant: z.enum(['development', 'staging', 'production']),
  configured: z.literal(true),
  projectId: z.string().min(1),
  legal: legalSchema,
  emulatorHost: z.string().nullable(),
});
export function legalLinks() {
  const result = legalSchema.safeParse(Constants.expoConfig?.extra?.legal);
  return result.success ? result.data : null;
}
export function nativePort(): MobilePort {
  let uid = '';
  const directory = new Directory(Paths.cache, 'puzzle-private-images');
  let services: ReturnType<typeof getFunctions> | null = null;
  let prepared = false;
  let check: ReturnType<typeof initializeAppCheck> | null = null;
  let initialization: Promise<OwnPreferences> | null = null;
  const boot = async (): Promise<OwnPreferences> => {
    const config = extraSchema.parse(Constants.expoConfig?.extra);
    const app = getApp();
    if (app.options.projectId !== config.projectId)
      throw new Error('Environment mismatch');
    const auth = getAuth(app);
    const installation = requireNativeModule<{
      needsReset: () => Promise<boolean>;
      commit: () => Promise<void>;
    }>('Installation');
    await resetInstallation({
      needsReset: () => installation.needsReset(),
      signOut: () => signOut(auth),
      removeSecureData: async () => {
        for (const key of ['own-preferences', 'own-deletion-key'])
          await SecureStore.deleteItemAsync(key);
      },
      purgeImages: () => {
        if (directory.exists) directory.delete();
        const gallery = galleryDirectory(GALLERY);
        if (gallery.exists) gallery.delete();
      },
      commit: () => installation.commit(),
    });
    if (!prepared) {
      initializeFirestore(app, { persistence: false });
      services = getFunctions(app, 'asia-northeast1');
      if (config.emulatorHost) {
        if (config.variant !== 'development' || !__DEV__)
          throw new Error('Emulators are development-only');
        connectAuthEmulator(auth, `http://${config.emulatorHost}:9099`, {
          disableWarnings: true,
        });
        connectFirestoreEmulator(getFirestore(app), config.emulatorHost, 8080);
        connectStorageEmulator(getStorage(app), config.emulatorHost, 9199);
        connectFunctionsEmulator(services, config.emulatorHost, 5001);
      }
      const provider = new ReactNativeFirebaseAppCheckProvider();
      provider.configure({
        android: {
          provider:
            config.variant === 'development' ? 'debug' : 'playIntegrity',
        },
        apple: {
          provider:
            config.variant === 'development'
              ? 'debug'
              : 'appAttestWithDeviceCheckFallback',
        },
      });
      check = initializeAppCheck(app, {
        provider,
        isTokenAutoRefreshEnabled: true,
      });
      prepared = true;
    }
    if (!check) throw new Error('App Check unavailable');
    await getToken(check, true);
    const user = auth.currentUser ?? (await signInAnonymously(auth)).user;
    if (!user.isAnonymous) throw new Error('Anonymous auth required');
    uid = user.uid;
    // Purge unfinished downloads from a prior process. Gallery is added separately in Phase 6.
    if (directory.exists) directory.delete();
    directory.create({ intermediates: true });
    const raw = await SecureStore.getItemAsync('own-preferences');
    if (!raw) return blank();
    let saved: z.infer<typeof savedSchema> | null = null;
    try {
      saved = savedSchema.parse(JSON.parse(raw));
    } catch {
      /* Discard corrupt or unbound preferences below. */
    }
    if (saved?.uid === uid) return saved.preferences;
    await SecureStore.deleteItemAsync('own-preferences');
    return blank();
  };
  const initialize = (): Promise<OwnPreferences> => {
    initialization ??= boot().catch((error: unknown) => {
      initialization = null;
      throw error;
    });
    return initialization;
  };
  return {
    initialize,
    galleryOwner: async () =>
      uid ? digestStringAsync(CryptoDigestAlgorithm.SHA256, uid) : null,
    eraseOwnData: async () => {
      initialization = null;
      uid = '';
      await eraseOwnData({
        removeSecureData: async () => {
          for (const key of ['own-preferences', 'own-deletion-key'])
            await SecureStore.deleteItemAsync(key);
        },
        purgeImages: () => {
          if (directory.exists) directory.delete();
          const gallery = galleryDirectory(GALLERY);
          if (gallery.exists) gallery.delete();
        },
        signOut: async () => {
          try {
            await signOut(getAuth(getApp()));
          } catch (error: unknown) {
            // The server may already have deleted the principal.
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
    savePreferences: async (value: OwnPreferences) => {
      if (!uid) throw new Error('Not initialized');
      await SecureStore.setItemAsync(
        'own-preferences',
        JSON.stringify(savedSchema.parse({ uid, preferences: value })),
        { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
      );
    },
    call: async (name, data) => {
      if (!services) throw new Error('Not initialized');
      return (await httpsCallable(services, name, { timeout: 180000 })(data))
        .data;
    },
    subscribeState: (changed, failed) => {
      let previous: string | null = null;
      return onSnapshot(
        doc(getFirestore(), `clientState/${uid}`),
        (snapshot) => {
          if (snapshot.metadata.fromCache) return;
          const value = JSON.stringify(snapshot.data());
          if (previous !== null && value !== previous) changed();
          previous = value;
        },
        failed,
      );
    },
    subscribeFit: (changed, failed) =>
      onSnapshot(
        doc(getFirestore(), `fitViews/${uid}`),
        (snapshot) => {
          if (!snapshot.metadata.fromCache && snapshot.exists())
            changed(fitViewData(snapshot.data()));
        },
        failed,
      ),
    subscribeBoard: (boardId, changed, failed) =>
      onSnapshot(
        doc(getFirestore(), `views/${uid}/boards/${boardId}`),
        (snapshot) => {
          if (!snapshot.metadata.fromCache) changed(snapshot.data());
        },
        failed,
      ),
    loadImages: async (board) => {
      const batch = new Directory(directory, randomUUID());
      batch.create({ intermediates: true });
      const uris: Record<string, string> = {};
      try {
        const results = await Promise.allSettled(
          board.pieces
            .filter((piece) => piece.visibility === 'visible')
            .map(async (piece) => {
              if (!piece.photoRef) throw new Error('Missing image');
              const file = new File(batch, `${piece.id}.jpg`);
              await writeToFile(ref(getStorage(), piece.photoRef), file.uri);
              uris[piece.id] = file.uri;
            }),
        );
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('Image access denied');
        return {
          uris,
          release: () => {
            if (batch.exists) batch.delete();
          },
        };
      } catch (error) {
        if (batch.exists) batch.delete();
        throw error;
      }
    },
  };
}
