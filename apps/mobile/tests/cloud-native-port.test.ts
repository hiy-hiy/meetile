import type { MobilePort } from '../src/controller';
const mockStore = new Map<string, string>();
let mockUser: { uid: string; isAnonymous: boolean } | null = null;
const mockSignOut = jest.fn(async () => {
  mockUser = null;
});
const mockSignIn = jest.fn(async () => {
  mockUser = { uid: 'synthetic-new-owner', isAnonymous: true };
  return { user: mockUser };
});
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {
      variant: 'development',
      configured: true,
      projectId: 'demo-synthetic',
      legal: {
        version: 'v1',
        terms: 'https://example.com/terms',
        privacy: 'https://example.com/privacy',
        community: 'https://example.com/community',
      },
      emulatorHost: null,
    },
  },
}));
jest.mock('expo-modules-core', () => {
  const actual =
    jest.requireActual<typeof import('expo-modules-core')>('expo-modules-core');
  return {
    ...actual,
    requireNativeModule: (name: string): unknown =>
      name === 'Installation'
        ? { needsReset: async () => false, commit: async () => {} }
        : actual.requireNativeModule<unknown>(name),
  };
});
jest.mock('expo-file-system', () => {
  class Directory {
    exists = false;
    delete() {}
    create() {}
  }
  return {
    Directory,
    File: class {},
    Paths: { cache: 'file:///cache', document: 'file:///documents' },
  };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => 'synthetic-uuid' }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockStore.delete(key);
  },
}));
jest.mock('@react-native-firebase/app', () => ({
  getApp: () => ({ options: { projectId: 'demo-synthetic' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => ({
    get currentUser() {
      return mockUser;
    },
  }),
  signInAnonymously: mockSignIn,
  signOut: mockSignOut,
  connectAuthEmulator: () => {},
}));
jest.mock('@react-native-firebase/app-check', () => ({
  initializeAppCheck: () => ({}),
  ReactNativeFirebaseAppCheckProvider: class {
    configure() {}
  },
  getToken: async () => ({ token: 'synthetic' }),
}));
jest.mock('@react-native-firebase/firestore', () => ({
  initializeFirestore: () => ({}),
  getFirestore: () => ({}),
  doc: () => ({}),
  onSnapshot: () => () => {},
  connectFirestoreEmulator: () => {},
}));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => async () => ({ data: null }),
  connectFunctionsEmulator: () => {},
}));
jest.mock('@react-native-firebase/storage', () => ({
  getStorage: () => ({}),
  ref: () => ({}),
  writeToFile: async () => {},
  connectStorageEmulator: () => {},
}));
const preferences = {
  username: '人工署名',
  legalVersion: 'v1',
  captureId: null,
  draft: null,
  pendingReports: [{ pieceId: 'synthetic-piece', reason: 'other' as const }],
};
function port(): MobilePort {
  let result: MobilePort | null = null;
  jest.isolateModules(() => {
    result = jest
      .requireActual<typeof import('../src/native-port')>('../src/native-port')
      .nativePort();
  });
  if (!result) throw new Error('Port unavailable');
  return result;
}
beforeEach(() => {
  mockStore.clear();
  mockUser = { uid: 'synthetic-owner', isAnonymous: true };
  jest.clearAllMocks();
});
test('restores own preferences only for the anonymous principal that saved them', async () => {
  const first = port();
  await first.initialize();
  await first.savePreferences(preferences);
  expect(await port().initialize()).toEqual(preferences);
});
test('a new principal never inherits consent or pending safety input from a previous one', async () => {
  const first = port();
  await first.initialize();
  await first.savePreferences(preferences);
  // e.g. the terminated principal was signed out but SecureStore erasure failed
  mockUser = null;
  const restored = await port().initialize();
  expect(mockSignIn).toHaveBeenCalled();
  expect(restored).toEqual({
    username: '',
    legalVersion: null,
    captureId: null,
    draft: null,
  });
  expect(mockStore.has('own-preferences')).toBe(false);
});
test('corrupt or unbound saved preferences are discarded instead of blocking startup', async () => {
  mockStore.set('own-preferences', JSON.stringify(preferences));
  expect((await port().initialize()).legalVersion).toBeNull();
  mockStore.set('own-preferences', '{');
  expect((await port().initialize()).legalVersion).toBeNull();
});
test('erasure removes own SecureStore entries and signs out, tolerating a deleted principal', async () => {
  const runtime = port();
  await runtime.initialize();
  await runtime.savePreferences(preferences);
  mockStore.set('own-deletion-key', 'synthetic');
  mockSignOut.mockRejectedValueOnce({ code: 'auth/no-current-user' });
  await runtime.eraseOwnData();
  expect(mockStore.size).toBe(0);
  await expect(runtime.savePreferences(preferences)).rejects.toThrow(
    'Not initialized',
  );
});
