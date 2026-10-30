import type { MobilePort } from '../src/controller';
import { artificialBoard } from './fixtures/board';
const mockProbe = 'e54f47e8-0d7a-4d70-b1c0-d469ff950f05';
const mockRun = 'a2dc6927-40bf-442b-88a2-2291909fcbd0';
const mockOtherRun = 'e33d7062-4a76-47e2-82ed-7442f276c18c';
const mockEvents: string[] = [];
const mockFiles = new Set<string>();
const mockDirectories = new Set<string>();
const mockDownload = jest.fn<
  Promise<{ uri: string }>,
  [string, { uri: string }, { headers: Record<string, string> }]
>(async (_url, file) => {
  mockFiles.add(file.uri);
  return file;
});
type LocalSnapshot = { metadata: { fromCache: boolean }; data: () => unknown };
const mockSnapshots = new Map<
  string,
  {
    changed: (value: LocalSnapshot) => void;
    failed: () => void;
    stop: jest.Mock;
  }
>();
const mockSnapshot = jest.fn(
  (
    path: string,
    changed: (value: LocalSnapshot) => void,
    failed: () => void,
  ) => {
    const stop = jest.fn();
    mockSnapshots.set(path, { changed, failed, stop });
    return stop;
  },
);
let mockEnabled = true;
let mockSaved: string | null = null;
let mockCurrentUser: { uid: string; isAnonymous: boolean } | null = null;
let mockProject = 'demo-puzzle-sns-local';
let mockRunId = mockRun;
let mockRPCStatus = 200;
const mockGuard = jest.fn(() => mockEnabled);
const mockGetApp = jest.fn(() => ({ options: { projectId: mockProject } }));
const mockReady = jest.fn(async () => {
  mockEvents.push('auth-ready');
});
const mockGetAuth = jest.fn(() => ({
  authStateReady: mockReady,
  get currentUser() {
    return mockCurrentUser;
  },
}));
const mockSignOut = jest.fn(async () => {
  mockEvents.push('sign-out');
  mockCurrentUser = null;
});
const mockSignIn = jest.fn(async () => {
  mockEvents.push('sign-in');
  mockCurrentUser = { uid: 'synthetic-new-owner', isAnonymous: true };
  return { user: mockCurrentUser };
});
const mockToken = jest.fn(async () => {
  mockEvents.push('token');
  return 'synthetic-token';
});
const mockCall = jest.fn<Promise<{ data: string }>, [string, unknown]>(
  async () => ({
    data: 'synthetic-result',
  }),
);
const mockFetch = jest.fn(
  async (
    address: string,
    options?: { body?: string; headers?: Record<string, string> },
  ) => {
    if (!address.includes('/localHealth?')) {
      const payload = JSON.parse(options?.body ?? 'null') as { data: unknown };
      const result = await mockCall(
        address.split('/').pop() ?? '',
        payload.data,
      );
      return {
        ok: mockRPCStatus === 200,
        status: mockRPCStatus,
        json: async () => ({ result: result.data }),
      };
    }
    mockEvents.push('health');
    return {
      ok: true,
      json: async () => ({
        mode: 'local',
        projectId: 'demo-puzzle-sns-local',
        protocol: 2,
        runId: mockRunId,
        probe: mockProbe,
      }),
    };
  },
);
const mockNeedsReset = jest.fn(async () => false);
const mockSettings = {
  mode: 'local',
  projectId: 'demo-puzzle-sns-local',
  host: '192.168.1.2',
  iosServices: 'synthetic.plist',
  androidServices: 'synthetic.json',
};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { localRuntime: mockSettings } } },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => mockProbe }));
jest.mock('expo-modules-core', () => {
  const actual =
    jest.requireActual<typeof import('expo-modules-core')>('expo-modules-core');
  return {
    ...actual,
    requireNativeModule: (name: string) =>
      name === 'Installation'
        ? {
            localBuildEnabled: mockGuard,
            needsReset: mockNeedsReset,
            commit: async () => {
              mockEvents.push('commit');
            },
          }
        : actual.requireNativeModule<unknown>(name),
  };
});
jest.mock('expo-file-system', () => ({
  Paths: {
    cache: 'file:///synthetic-cache',
    document: 'file:///synthetic-documents',
  },
  Directory: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts
        .map((part) => (typeof part === 'string' ? part : part.uri))
        .join('/');
    }
    get exists() {
      return mockDirectories.has(this.uri);
    }
    create() {
      mockDirectories.add(this.uri);
    }
    delete() {
      mockEvents.push('purge');
      mockDirectories.delete(this.uri);
      for (const file of mockFiles)
        if (file.startsWith(this.uri + '/')) mockFiles.delete(file);
    }
  },
  File: class {
    static downloadFileAsync = mockDownload;
    uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = parent.uri + '/' + name;
    }
  },
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
  getItemAsync: async () => mockSaved,
  setItemAsync: async (_key: string, value: string) => {
    mockEvents.push('save');
    mockSaved = value;
  },
  deleteItemAsync: async () => {
    mockEvents.push('erase');
    mockSaved = null;
  },
}));
jest.mock('@react-native-firebase/app', () => ({ getApp: mockGetApp }));
jest.mock('@react-native-firebase/auth', () => ({
  getAuth: mockGetAuth,
  connectAuthEmulator: (_auth: unknown, url: string) => {
    mockEvents.push('auth-emulator:' + url);
  },
  signInAnonymously: mockSignIn,
  signOut: mockSignOut,
  getIdToken: mockToken,
}));
jest.mock('@react-native-firebase/firestore', () => ({
  initializeFirestore: (_app: unknown, settings: unknown) => {
    mockEvents.push('firestore-settings:' + JSON.stringify(settings));
    return {};
  },
  connectFirestoreEmulator: (_db: unknown, host: string, port: number) => {
    mockEvents.push(`firestore-emulator:${host}:${port}`);
  },
  doc: (_db: unknown, path: string) => path,
  onSnapshot: mockSnapshot,
}));
jest.mock('@react-native-firebase/storage', () => ({
  getStorage: () => ({}),
  connectStorageEmulator: (_storage: unknown, host: string, port: number) => {
    mockEvents.push(`storage-emulator:${host}:${port}`);
  },
}));
jest.mock('@react-native-firebase/functions', () => ({
  getFunctions: () => ({}),
  connectFunctionsEmulator: (
    _functions: unknown,
    host: string,
    port: number,
  ) => {
    mockEvents.push(`functions-emulator:${host}:${port}`);
  },
}));
const originalFetch = Object.getOwnPropertyDescriptor(global, 'fetch');
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockEvents.length = 0;
  mockFiles.clear();
  mockDirectories.clear();
  mockDirectories.add('file:///synthetic-cache/local-private-images');
  mockSnapshots.clear();
  mockEnabled = true;
  mockSaved = null;
  mockCurrentUser = null;
  mockProject = 'demo-puzzle-sns-local';
  mockRunId = mockRun;
  mockRPCStatus = 200;
  Object.defineProperty(global, 'fetch', {
    configurable: true,
    writable: true,
    value: mockFetch,
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalFetch) Object.defineProperty(global, 'fetch', originalFetch);
  else Reflect.deleteProperty(global, 'fetch');
});
function port(): MobilePort {
  let result: MobilePort | null = null;
  jest.isolateModules(() => {
    result = jest
      .requireActual<typeof import('../src/local/native-port')>(
        '../src/local/native-port',
      )
      .localPort();
  });
  if (!result) throw new Error('Port unavailable');
  return result;
}
function saveFixture(runId = mockRun, uid = 'synthetic-owner') {
  mockCurrentUser = { uid: 'synthetic-owner', isAnonymous: true };
  mockSaved = JSON.stringify({
    runId,
    uid,
    preferences: {
      username: '人工署名',
      legalVersion: 'local-test-v1',
      captureId: 'synthetic-session',
      draft: null,
    },
  });
}
test('normal binary and real registration are rejected before services or network', async () => {
  mockEnabled = false;
  await expect(port().initialize()).rejects.toThrow('Local Debug');
  expect(mockGetApp).not.toHaveBeenCalled();
  mockEnabled = true;
  mockProject = 'real-project';
  await expect(port().initialize()).rejects.toThrow();
  expect(mockGetAuth).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});
test('redirects every SDK before first health/auth request, and serializes initialization', async () => {
  const runtime = port();
  const first = runtime.initialize();
  expect(runtime.initialize()).toBe(first);
  expect(await first).toEqual({
    username: '',
    legalVersion: null,
    captureId: null,
    draft: null,
  });
  expect(mockEvents.slice(0, 6)).toEqual([
    'auth-emulator:http://192.168.1.2:19099',
    'firestore-settings:{"persistence":false}',
    'firestore-emulator:192.168.1.2:18080',
    'storage-emulator:192.168.1.2:19199',
    'functions-emulator:192.168.1.2:15001',
    'health',
  ]);
  expect(mockEvents.indexOf('commit')).toBeGreaterThan(
    mockEvents.indexOf('erase'),
  );
  expect(mockEvents.indexOf('sign-in')).toBeGreaterThan(
    mockEvents.indexOf('commit'),
  );
  expect(mockToken).toHaveBeenCalledTimes(1);
  expect(mockSignOut).not.toHaveBeenCalled();
});
test('restores existing anonymous ownership and acknowledgement after ordinary restart', async () => {
  saveFixture();
  const restored = await port().initialize();
  expect(restored).toMatchObject({
    username: '人工署名',
    legalVersion: 'local-test-v1',
    captureId: 'synthetic-session',
  });
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockSignIn).not.toHaveBeenCalled();
});
test('pending own report input survives normal restart but is erased on a local environment reset', async () => {
  saveFixture();
  const runtime = port();
  const preferences = await runtime.initialize();
  await runtime.savePreferences({
    ...preferences,
    pendingReports: [{ pieceId: 'synthetic-reported-piece', reason: 'other' }],
    pendingBlocks: [{ pieceId: 'synthetic-blocked-piece' }],
  });
  expect((await runtime.initialize()).pendingBlocks).toEqual([
    { pieceId: 'synthetic-blocked-piece' },
  ]);
  expect((await runtime.initialize()).pendingReports).toEqual([
    { pieceId: 'synthetic-reported-piece', reason: 'other' },
  ]);
  mockRunId = mockOtherRun;
  expect((await runtime.initialize()).pendingReports).toBeUndefined();
  expect((await runtime.initialize()).pendingBlocks).toBeUndefined();
});
test('waits for native auth restoration before deciding to discard a saved identity', async () => {
  saveFixture();
  mockCurrentUser = null;
  let restore = () => {};
  mockReady.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        restore = resolve;
      }),
  );
  const ready = port().initialize();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mockReady).toHaveBeenCalled();
  expect(mockSignOut).not.toHaveBeenCalled();
  mockCurrentUser = { uid: 'synthetic-owner', isAnonymous: true };
  restore();
  expect((await ready).captureId).toBe('synthetic-session');
  expect(mockSignIn).not.toHaveBeenCalled();
});
test.each(['run', 'owner', 'installation'])(
  'clears old local identity/preferences on %s mismatch before reauthentication',
  async (reason) => {
    saveFixture(
      reason === 'run' ? mockOtherRun : mockRun,
      reason === 'owner' ? 'synthetic-wrong-owner' : 'synthetic-owner',
    );
    if (reason === 'installation') mockNeedsReset.mockResolvedValueOnce(true);
    const restored = await port().initialize();
    expect(restored.legalVersion).toBeNull();
    expect(restored.captureId).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  },
);
test('Mac unavailability rejects before anonymous sign-in or overwriting saved preferences', async () => {
  saveFixture();
  const before = mockSaved;
  mockFetch.mockRejectedValueOnce(new Error('offline'));
  await expect(port().initialize()).rejects.toThrow('offline');
  expect(mockSignIn).not.toHaveBeenCalled();
  expect(mockToken).not.toHaveBeenCalled();
  expect(mockSaved).toBe(before);
});
test('only treats a missing native user as an idempotent logout; other logout failures cannot commit reset', async () => {
  saveFixture(mockOtherRun);
  mockSignOut.mockRejectedValueOnce({ code: 'auth/no-current-user' });
  expect((await port().initialize()).legalVersion).toBeNull();
  saveFixture(mockOtherRun);
  mockSignOut.mockRejectedValueOnce({ code: 'auth/internal-error' });
  const before = mockEvents.filter((event) => event === 'commit').length;
  await expect(port().initialize()).rejects.toEqual({
    code: 'auth/internal-error',
  });
  expect(mockEvents.filter((event) => event === 'commit')).toHaveLength(before);
});
test('only exposes step 4 routes and binds every request to the verified local instance', async () => {
  const runtime = port();
  await runtime.initialize();
  expect(await runtime.call('getDayState', {})).toBe('synthetic-result');
  expect(mockCall).toHaveBeenCalledWith('getDayState', {
    runId: mockRun,
    data: {},
  });
  // The gallery listing is routed to the same verified local instance.
  await runtime.call('listGallery', {});
  expect(mockCall).toHaveBeenCalledWith('listGallery', {
    runId: mockRun,
    data: {},
  });
  await runtime.call('acceptOnboarding', {
    age16OrOlder: true,
    accepted: true,
    legalVersion: 'local-test-v1',
  });
  expect(mockCall).toHaveBeenCalledWith(
    'acceptLocalTest',
    expect.objectContaining({ runId: mockRun }),
  );
  await expect(runtime.call('adminDecision', {})).rejects.toThrow('step 4');
  // FIT routes carry the same verified run binding as every other local request.
  await runtime.call('beginFitScan', {});
  await runtime.call('simulatePeer', { token: 'T'.repeat(22) });
  expect(mockCall).toHaveBeenCalledWith('beginFitScan', {
    runId: mockRun,
    data: {},
  });
  expect(mockCall).toHaveBeenCalledWith('simulatePeer', {
    runId: mockRun,
    data: { token: 'T'.repeat(22) },
  });
  await expect(
    runtime.call('acceptOnboarding', {
      age16OrOlder: true,
      accepted: true,
      legalVersion: 'cloud-v1',
    }),
  ).rejects.toThrow();
  const count = mockCall.mock.calls.length;
  mockRunId = mockOtherRun;
  await expect(runtime.call('beginCapture', {})).rejects.toThrow(
    'environment changed',
  );
  expect(mockCall).toHaveBeenCalledTimes(count);
  expect((await runtime.initialize()).legalVersion).toBeNull();
});

test('watchdog detects a replaced Mac environment without overwriting identity until reconnect', async () => {
  saveFixture();
  const runtime = port();
  await runtime.initialize();
  const original = mockSaved;
  await runtime.checkConnection?.();
  mockRunId = mockOtherRun;
  await expect(runtime.checkConnection?.()).rejects.toThrow(
    'environment changed',
  );
  expect(mockSaved).toBe(original);
  expect(mockSignOut).not.toHaveBeenCalled();
  const reset = await runtime.initialize();
  expect(reset).toEqual({
    username: '',
    legalVersion: null,
    captureId: null,
    draft: null,
  });
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(mockFiles.size).toBe(0);
});
test('observes only own documents, ignores cache and unsubscribed callbacks, and propagates access failure', async () => {
  const runtime = port();
  await expect(runtime.loadImages(artificialBoard)).rejects.toThrow('session');
  expect(() => runtime.subscribeState(jest.fn(), jest.fn())).toThrow('session');
  await runtime.initialize();
  const changed = jest.fn();
  const failed = jest.fn();
  const stopState = runtime.subscribeState(changed, failed);
  const state = mockSnapshots.get('clientState/synthetic-new-owner')!;
  state.changed({
    metadata: { fromCache: true },
    data: () => ({ accessRevision: 0 }),
  });
  state.changed({
    metadata: { fromCache: false },
    data: () => ({ accessRevision: 1 }),
  });
  expect(changed).not.toHaveBeenCalled();
  state.changed({
    metadata: { fromCache: false },
    data: () => ({ accessRevision: 2 }),
  });
  expect(changed).toHaveBeenCalledTimes(1);
  const boardChanged = jest.fn();
  const stopBoard = runtime.subscribeBoard(
    'synthetic-board',
    boardChanged,
    failed,
  );
  const board = mockSnapshots.get(
    'views/synthetic-new-owner/boards/synthetic-board',
  )!;
  board.changed({
    metadata: { fromCache: false },
    data: () => artificialBoard,
  });
  expect(boardChanged).toHaveBeenCalledWith(artificialBoard);
  board.failed();
  expect(failed).toHaveBeenCalledTimes(1);
  stopState();
  stopBoard();
  board.changed({
    metadata: { fromCache: false },
    data: () => artificialBoard,
  });
  expect(boardChanged).toHaveBeenCalledTimes(1);
  expect(board.stop).toHaveBeenCalled();
});
test('FIT progress drops the storage-only TTL field before reaching the controller', async () => {
  const runtime = port();
  await runtime.initialize();
  const changed = jest.fn();
  const stop = runtime.subscribeFit!(changed, jest.fn());
  mockSnapshots.get('fitViews/synthetic-new-owner')!.changed({
    metadata: { fromCache: false },
    data: () => ({
      sessionId: 's_synthetic',
      stage: 'cancelled',
      reason: null,
      boardId: null,
      boardChanged: false,
      expireAt: { seconds: 1, nanoseconds: 0 },
    }),
  });
  expect(changed).toHaveBeenCalledWith({
    sessionId: 's_synthetic',
    stage: 'cancelled',
    reason: null,
    boardId: null,
    boardChanged: false,
  });
  stop();
});

test('downloads only visible normalized objects into disposable private files without public URLs', async () => {
  const runtime = port();
  await runtime.initialize();
  const hidden = {
    ...artificialBoard.pieces[0]!,
    id: 'hidden',
    visibility: 'blank' as const,
    photoRef: null,
    username: null,
    caption: null,
  };
  const result = await runtime.loadImages({
    ...artificialBoard,
    pieces: [...artificialBoard.pieces, hidden],
  });
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload).toHaveBeenCalledWith(
    'http://192.168.1.2:19199/v0/b/demo-puzzle-sns-local.appspot.com/o/normalized%2Fsynthetic-piece%2Fimage?alt=media',
    expect.anything(),
    expect.objectContaining({
      headers: { Authorization: 'Bearer synthetic-token' },
    }),
  );
  expect(mockDownload.mock.calls[0]?.[1].uri).toContain(
    '/local-private-images/',
  );
  expect(Object.keys(result.uris)).toEqual(['synthetic-piece']);
  expect(result.uris['synthetic-piece']).toMatch(/^file:\/\//);
  expect(mockFiles.size).toBe(1);
  result.release();
  expect(mockFiles.size).toBe(0);
  await expect(
    runtime.loadImages({
      ...artificialBoard,
      pieces: [
        {
          ...artificialBoard.pieces[0]!,
          photoRef: 'https://example.invalid/image',
        },
      ],
    }),
  ).rejects.toThrow();
  expect(mockDownload).toHaveBeenCalledTimes(1);
});
test('purges partially downloaded batches and rejects changed local identity/environment', async () => {
  const runtime = port();
  await runtime.initialize();
  mockDownload.mockImplementationOnce(async (_path, file) => {
    mockFiles.add(file.uri);
    throw new Error('denied');
  });
  await expect(runtime.loadImages(artificialBoard)).rejects.toThrow('access');
  expect(mockFiles.size).toBe(0);
  mockRunId = mockOtherRun;
  await expect(runtime.loadImages(artificialBoard)).rejects.toThrow(
    'environment',
  );
  mockRunId = mockRun;
  mockCurrentUser = { uid: 'changed-owner', isAnonymous: true };
  await expect(runtime.loadImages(artificialBoard)).rejects.toThrow('identity');
  expect(mockDownload).toHaveBeenCalledTimes(1);
});
test('sends the native anonymous token explicitly to the fixed local endpoint and rejects failed HTTP responses', async () => {
  const runtime = port();
  await runtime.initialize();
  await runtime.call('getDayState', {});
  expect(mockFetch).toHaveBeenCalledWith(
    'http://192.168.1.2:15001/demo-puzzle-sns-local/asia-northeast1/getDayState',
    expect.objectContaining({
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer synthetic-token',
      },
    }),
  );
  mockRPCStatus = 401;
  await expect(runtime.call('getDayState', {})).rejects.toThrow('rejected');
  expect(console.warn).toHaveBeenCalledWith('Local request rejected', {
    operation: 'getDayState',
    status: 401,
  });
});
test('routes termination and erases own preferences, private images and sign-in afterwards', async () => {
  const runtime = port();
  await runtime.initialize();
  await runtime.call('endUse', { confirm: true });
  expect(mockCall).toHaveBeenCalledWith(
    'endUse',
    expect.objectContaining({ runId: mockRun, data: { confirm: true } }),
  );
  mockFiles.add('file:///synthetic-cache/local-private-images/batch/a.jpg');
  await runtime.eraseOwnData();
  expect(mockSaved).toBeNull();
  expect(
    mockDirectories.has('file:///synthetic-cache/local-private-images'),
  ).toBe(false);
  expect(mockCurrentUser).toBeNull();
  await expect(runtime.call('getDayState', {})).rejects.toThrow(
    'Not initialized',
  );
});
test('erasure still removes data when the principal was already deleted, and reports other sign-out failures', async () => {
  const runtime = port();
  await runtime.initialize();
  mockSignOut.mockRejectedValueOnce({ code: 'auth/no-current-user' });
  await expect(runtime.eraseOwnData()).resolves.toBeUndefined();
  expect(mockSaved).toBeNull();
  const other = port();
  await other.initialize();
  mockSignOut.mockRejectedValueOnce(new Error('Artificial failure'));
  await expect(other.eraseOwnData()).rejects.toThrow();
  expect(mockSaved).toBeNull();
});
