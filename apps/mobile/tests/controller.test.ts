import {
  MobileController,
  type MobilePort,
  type OwnPreferences,
} from '../src/controller';
import type { BoardView } from '@puzzle-sns/contracts';
const day = {
  dayKey: '2026-10-10',
  serverTimeMs: 1791601200000,
  ownPieceId: 'piece',
  boardId: 'board',
  photoState: 'ready',
};
const board: BoardView = {
  boardId: 'board',
  dayKey: '2026-10-10',
  version: 1,
  pieces: [
    {
      id: 'piece',
      position: { x: 0, y: 0 },
      edges: {
        north: 'round-out',
        east: 'round-in',
        south: 'square-out',
        west: 'square-in',
      },
      visibility: 'visible',
      photoRef: 'normalized/piece/image',
      username: '人工署名',
      caption: '人工図形',
    },
  ],
};
function setup() {
  const preferences: OwnPreferences = {
    username: '署名',
    legalVersion: 'v1',
    captureId: null,
    draft: null,
  };
  const release = jest.fn();
  let stateChanged = () => {};
  let changed: (value: unknown) => void = () => {};
  let failed = () => {};
  const port: MobilePort = {
    initialize: jest.fn(async () => preferences),
    savePreferences: jest.fn(async () => {}),
    eraseOwnData: jest.fn(async () => {}),
    call: jest.fn(async (name) => (name === 'getDayState' ? day : board)),
    subscribeState: jest.fn((fn) => {
      stateChanged = fn;
      return () => {};
    }),
    subscribeBoard: jest.fn((_id, fn, error) => {
      changed = fn;
      failed = error;
      return () => {};
    }),
    loadImages: jest.fn(async () => ({
      uris: { piece: 'file:///private/artificial.jpg' },
      release,
    })),
  };
  return {
    controller: new MobileController(port, 'v1'),
    port,
    preferences,
    release,
    changed: (value: unknown) => changed(value),
    stateChanged: () => stateChanged(),
    accessFailed: () => failed(),
  };
}
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
test('reads canonical pointer and authenticated view, never persists other people’s images/preferences', async () => {
  const { controller, port } = setup();
  await controller.start();
  expect(controller.snapshot().phase).toBe('today');
  expect(controller.snapshot().uris.piece).toContain('/private/');
  expect(port.call).toHaveBeenCalledWith('syncBoardView', { boardId: 'board' });
  expect(port.savePreferences).not.toHaveBeenCalled();
});
test('clears photos immediately on background/disconnect and refetches on reconnect', async () => {
  const { controller, release, port } = setup();
  await controller.start();
  controller.setAvailable(false);
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    board: null,
    uris: {},
  });
  expect(release).toHaveBeenCalledTimes(1);
  controller.setAvailable(true);
  await flush();
  expect(port.call).toHaveBeenCalledWith('getDayState', {});
  expect(controller.snapshot().phase).toBe('today');
});
test('late image completion cannot redisplay content after access has been lost', async () => {
  const { controller, port } = setup();
  let complete:
    | ((value: { uris: Record<string, string>; release: () => void }) => void)
    | undefined;
  port.loadImages = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const start = controller.start();
  await flush();
  controller.setAvailable(false);
  const release = jest.fn();
  complete?.({ uris: { piece: 'file:///private/late.jpg' }, release });
  await start;
  expect(release).toHaveBeenCalled();
  expect(controller.snapshot().uris).toEqual({});
});
test('blanking a subscribed piece clears its previously downloaded photo and texts', async () => {
  const { controller, changed, release } = setup();
  await controller.start();
  changed({
    ...board,
    version: 2,
    pieces: board.pieces.map((piece) => ({
      ...piece,
      visibility: 'blank',
      photoRef: null,
      username: null,
      caption: null,
    })),
  });
  await flush();
  expect(release).toHaveBeenCalled();
  expect(controller.snapshot().board?.pieces[0]?.username).toBeNull();
});
test('requires the current legal version before opening capture or exposing a board', async () => {
  const { controller, preferences, port } = setup();
  preferences.legalVersion = 'old';
  await controller.start();
  expect(controller.snapshot().phase).toBe('onboarding');
  expect(port.loadImages).not.toHaveBeenCalled();
});
test('server rollover switches to new capture without trusting device date', async () => {
  const { controller, port, stateChanged } = setup();
  await controller.start();
  const capture = {
    captureId: 'c',
    dayKey: '2026-10-11',
    status: 'open',
    uploadPath: 'pending/c/image',
    boardId: null,
    username: null,
    caption: null,
  };
  port.call = jest.fn(async (name) =>
    name === 'getDayState'
      ? {
          ...day,
          dayKey: '2026-10-11',
          ownPieceId: null,
          boardId: null,
          photoState: 'not-created',
        }
      : capture,
  );
  stateChanged();
  await flush();
  expect(controller.snapshot()).toMatchObject({
    phase: 'capture',
    board: null,
    capture,
  });
});
test('freezes submission signature, ignores double tap and ignores response after disconnect', async () => {
  const { controller, port } = setup();
  const capture = {
    captureId: 'c',
    dayKey: day.dayKey,
    status: 'open',
    uploadPath: 'pending/c/image',
    boardId: null,
    username: null,
    caption: null,
  };
  let finish: (() => void) | undefined;
  port.call = jest.fn(async (name) =>
    name === 'getDayState'
      ? { ...day, ownPieceId: null, boardId: null, photoState: 'not-created' }
      : name === 'uploadCapture'
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : name === 'submitCapture'
          ? { ...capture, status: 'held', username: '署名', caption: '人工' }
          : capture,
  );
  await controller.start();
  const post = controller.post('/9g=', '人工');
  await flush();
  await controller.post('/9g=', '人工');
  await controller.setUsername('変更後');
  controller.setAvailable(false);
  finish?.();
  await post;
  expect(port.call).toHaveBeenCalledWith('submitCapture', {
    captureId: 'c',
    username: '署名',
    caption: '人工',
  });
  expect(controller.snapshot().phase).toBe('offline');
});

test('failed cache removal still blanks the board before returning offline', async () => {
  const { controller, port } = setup();
  port.loadImages = async () => ({
    uris: { piece: 'file:///private/fixture.jpg' },
    release: () => {
      throw new Error('Artificial filesystem outage');
    },
  });
  await controller.start();
  controller.setAvailable(false);
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    board: null,
    uris: {},
  });
});
test('routine server-day polling retains the board and avoids another image download', async () => {
  const { controller, port } = setup();
  await controller.start();
  await controller.pollDay();
  expect(port.loadImages).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().phase).toBe('today');
});

test('initial service outage can be retried without claiming an app is ready', async () => {
  const { controller, port } = setup();
  let attempts = 0;
  port.initialize = async () => {
    if (attempts++ === 0) throw new Error('Artificial service outage');
    return { username: '', legalVersion: 'v1', captureId: null, draft: null };
  };
  await controller.start();
  expect(controller.snapshot().phase).toBe('error');
  await controller.refresh();
  expect(controller.snapshot().phase).toBe('today');
});

test('explicit reconnect restores the same board after polling detected a Mac outage', async () => {
  const { controller, port, release } = setup();
  await controller.start();
  jest.mocked(port.call).mockRejectedValueOnce(new Error('Mac stopped'));
  await controller.pollDay();
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    uris: {},
    board: null,
  });
  expect(release).toHaveBeenCalledTimes(1);
  await controller.reconnect();
  expect(controller.snapshot().phase).toBe('today');
  expect(port.initialize).toHaveBeenCalledTimes(2);
  expect(port.loadImages).toHaveBeenCalledTimes(2);
});

test('a late initialization cannot reveal a board after backgrounding', async () => {
  const { controller, port } = setup();
  let finish = () => {};
  port.initialize = () =>
    new Promise((resolve) => {
      finish = () =>
        resolve({
          username: '',
          legalVersion: 'v1',
          captureId: null,
          draft: null,
        });
    });
  const pending = controller.reconnect();
  await flush();
  controller.setAvailable(false);
  finish();
  await pending;
  expect(controller.snapshot().phase).toBe('offline');
  expect(port.call).not.toHaveBeenCalled();
});

test('connection watchdog blanks images but ignores a failure from an older generation', async () => {
  const { controller, port } = setup();
  let fail: (error: Error) => void = () => {};
  port.checkConnection = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  await controller.start();
  const previous = controller.checkConnection();
  await controller.reconnect();
  fail(new Error('old heartbeat'));
  await previous;
  expect(controller.snapshot().phase).toBe('today');
  port.checkConnection = jest.fn(async () => {
    throw new Error('Mac stopped');
  });
  await controller.checkConnection();
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    uris: {},
    board: null,
  });
});

function deletingSetup() {
  const result = setup();
  let deleted = false;
  const blank: BoardView = {
    ...board,
    pieces: board.pieces.map((piece) => ({
      ...piece,
      visibility: 'blank',
      photoRef: null,
      username: null,
      caption: null,
    })),
  };
  result.preferences.captureId = 'capture';
  result.preferences.draft = {
    captureId: 'capture',
    username: '署名',
    caption: '人工',
  };
  result.port.call = jest.fn(async (name) => {
    if (name === 'deleteOwnPhoto') {
      deleted = true;
      return { status: 'deleted' };
    }
    if (name === 'getDayState')
      return { ...day, photoState: deleted ? 'unavailable' : 'ready' };
    return deleted ? blank : board;
  });
  result.port.loadImages = jest.fn(async (view) => ({
    uris:
      view.pieces[0]?.visibility === 'visible'
        ? { piece: 'file:///private/artificial.jpg' }
        : {},
    release: result.release,
  }));
  return {
    ...result,
    deleteOnServer: () => {
      deleted = true;
    },
  };
}
test('confirmed deletion purges images and local draft, retains the blank board, and never begins capture again', async () => {
  const { controller, port, release } = deletingSetup();
  await controller.start();
  await controller.deleteOwnPhoto('another-piece');
  expect(port.call).not.toHaveBeenCalledWith(
    'deleteOwnPhoto',
    expect.anything(),
  );
  await controller.deleteOwnPhoto('piece');
  expect(release).toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    day: { photoState: 'unavailable' },
    board: { pieces: [{ visibility: 'blank', caption: null, photoRef: null }] },
    uris: {},
  });
  expect(port.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ captureId: null, draft: null }),
  );
  expect(port.call).not.toHaveBeenCalledWith('beginCapture', expect.anything());
});
test('pending deletion blocks repeated taps and refresh; a background completion cannot reveal the old photo', async () => {
  const { controller, port, deleteOnServer } = deletingSetup();
  const original = port.call;
  let complete = () => {};
  port.call = jest.fn(async (name, input) =>
    name === 'deleteOwnPhoto'
      ? new Promise((resolve) => {
          complete = () => {
            deleteOnServer();
            resolve({ status: 'deleted' });
          };
        })
      : original(name, input),
  );
  await controller.start();
  const pending = controller.deleteOwnPhoto('piece');
  expect(controller.snapshot()).toMatchObject({
    phase: 'deleting',
    uris: {},
    board: null,
  });
  await controller.deleteOwnPhoto('piece');
  await controller.refresh();
  await controller.reconnect();
  expect(
    jest
      .mocked(port.call)
      .mock.calls.filter(([name]) => name === 'deleteOwnPhoto'),
  ).toHaveLength(1);
  controller.setAvailable(false);
  complete();
  await pending;
  expect(controller.snapshot()).toMatchObject({ phase: 'offline', uris: {} });
  controller.setAvailable(true);
  await flush();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    uris: {},
    day: { photoState: 'unavailable' },
  });
});
test('a lost deletion response stays blank until an explicit refresh reads the authoritative result', async () => {
  const { controller, port, deleteOnServer } = deletingSetup();
  const original = port.call;
  port.call = jest.fn(async (name, data) => {
    if (name === 'deleteOwnPhoto') {
      deleteOnServer();
      throw new Error('Response lost');
    }
    return original(name, data);
  });
  await controller.start();
  await controller.deleteOwnPhoto('piece');
  expect(controller.snapshot()).toMatchObject({
    phase: 'error',
    uris: {},
    board: null,
  });
  await controller.refresh();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    uris: {},
    day: { photoState: 'unavailable' },
  });
});
test('an invalidated view grant hides photos first, then reauthorizes and renders the latest blank view', async () => {
  const { controller, port, accessFailed } = deletingSetup();
  await controller.start();
  const original = port.call;
  port.call = jest.fn(async (name, data) => {
    const value = await original(name, data);
    if (name !== 'syncBoardView') return value;
    return {
      ...board,
      pieces: board.pieces.map((piece) => ({
        ...piece,
        visibility: 'blank',
        username: null,
        caption: null,
        photoRef: null,
      })),
    };
  });
  accessFailed();
  expect(controller.snapshot().uris).toEqual({});
  await flush();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    uris: {},
    board: { pieces: [{ visibility: 'blank' }] },
  });
});
test('persistent grant rejection stops after one recovery instead of retrying forever', async () => {
  const { controller, port } = setup();
  port.subscribeBoard = (_id, _changed, failed) => {
    void Promise.resolve().then(failed);
    return () => {};
  };
  await controller.start();
  await flush();
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    uris: {},
    board: null,
  });
  expect(
    jest
      .mocked(port.call)
      .mock.calls.filter(([name]) => name === 'syncBoardView').length,
  ).toBeLessThanOrEqual(2);
});
test('a remotely deleted own photo clears the draft and shows the deletion notice on state subscription', async () => {
  const { controller, port, stateChanged, deleteOnServer } = deletingSetup();
  await controller.start();
  deleteOnServer();
  stateChanged();
  await flush();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    day: { photoState: 'unavailable' },
    uris: {},
    message: '今日の写真は削除されています。次の日にまた撮影できます。',
  });
  expect(port.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ draft: null, captureId: null }),
  );
});

function reportingSetup(
  operation: 'reportPhoto' | 'blockPhoto' = 'reportPhoto',
) {
  const result = setup();
  const other = {
    ...board.pieces[0]!,
    id: 'other-piece',
    position: { x: 1, y: 0 },
    photoRef: 'normalized/other-piece/image',
    username: '別の人工署名',
    caption: '別の人工図形',
  };
  const shared = { ...board, pieces: [...board.pieces, other] };
  let stored: OwnPreferences = {
    username: '',
    legalVersion: 'v1',
    captureId: null,
    draft: null,
  };
  let received = false;
  let unavailable = false;
  result.port.initialize = jest.fn(
    async () => JSON.parse(JSON.stringify(stored)) as OwnPreferences,
  );
  result.port.savePreferences = jest.fn(async (value) => {
    stored = JSON.parse(JSON.stringify(value)) as OwnPreferences;
  });
  result.port.call = jest.fn(async (name) => {
    if (name === operation) {
      if (unavailable) throw new Error('Synthetic network outage');
      received = true;
      return { status: operation === 'reportPhoto' ? 'reported' : 'blocked' };
    }
    if (name === 'getDayState') return day;
    return {
      ...shared,
      pieces: shared.pieces.map((piece) =>
        received && piece.id === 'other-piece'
          ? {
              ...piece,
              visibility: 'blank',
              photoRef: null,
              username: null,
              caption: null,
            }
          : piece,
      ),
    };
  });
  result.port.loadImages = jest.fn(async (view) => ({
    uris: Object.fromEntries(
      view.pieces
        .filter((piece) => piece.visibility === 'visible')
        .map((piece) => [piece.id, `file:///private/${piece.id}.jpg`]),
    ),
    release: result.release,
  }));
  return {
    ...result,
    outage: (value: boolean) => {
      unavailable = value;
    },
    saved: () => stored,
  };
}
test('reporting hides photo/text and purges the old image batch before any save or network completion', async () => {
  const { controller, port, release, saved } = reportingSetup();
  await controller.start();
  const report = controller.reportPhoto('other-piece', 'harassment');
  expect(
    controller
      .snapshot()
      .board?.pieces.find((piece) => piece.id === 'other-piece'),
  ).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
  expect(controller.snapshot().uris).toEqual({});
  expect(release).toHaveBeenCalled();
  await report;
  expect(port.call).toHaveBeenCalledWith('reportPhoto', {
    pieceId: 'other-piece',
    reason: 'harassment',
  });
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    reportState: 'sent',
  });
  expect(controller.snapshot().uris['other-piece']).toBeUndefined();
  expect(controller.snapshot().uris.piece).toBeTruthy();
  expect(saved().pendingReports).toEqual([]);
});
test('an unsent report persists across restart, masks before image download, then retries without changing its reason', async () => {
  const { controller, port, outage, saved } = reportingSetup();
  outage(true);
  await controller.start();
  await controller.reportPhoto('other-piece', 'personal-info');
  expect(controller.snapshot().reportState).toBe('pending');
  expect(saved().pendingReports).toEqual([
    { pieceId: 'other-piece', reason: 'personal-info' },
  ]);
  controller.stop();
  jest.mocked(port.loadImages).mockClear();
  const restarted = new MobileController(port, 'v1');
  await restarted.start();
  expect(restarted.snapshot().uris['other-piece']).toBeUndefined();
  expect(
    jest
      .mocked(port.loadImages)
      .mock.calls.every(
        ([view]) =>
          view.pieces.find((piece) => piece.id === 'other-piece')
            ?.visibility === 'blank',
      ),
  ).toBe(true);
  outage(false);
  await restarted.retryReports();
  expect(restarted.snapshot().reportState).toBe('sent');
  expect(saved().pendingReports).toEqual([]);
  expect(
    jest
      .mocked(port.call)
      .mock.calls.filter(([name]) => name === 'reportPhoto')
      .every(
        ([, data]) =>
          JSON.stringify(data) ===
          JSON.stringify({ pieceId: 'other-piece', reason: 'personal-info' }),
      ),
  ).toBe(true);
});
test('no network submission happens before durable queue storage; storage errors keep the target hidden for retry', async () => {
  const { controller, port } = reportingSetup();
  await controller.start();
  const save = port.savePreferences;
  let fail = true;
  port.savePreferences = jest.fn(async (value) => {
    if (fail) throw new Error('Synthetic storage outage');
    await save(value);
  });
  await controller.reportPhoto('other-piece', 'other');
  expect(controller.snapshot().reportState).toBe('pending');
  expect(controller.snapshot().uris['other-piece']).toBeUndefined();
  expect(port.call).not.toHaveBeenCalledWith('reportPhoto', expect.anything());
  await controller.reconnect();
  expect(controller.snapshot().phase).toBe('error');
  expect(controller.snapshot().uris).toEqual({});
  fail = false;
  await controller.retryReports();
  expect(controller.snapshot().reportState).toBe('sent');
});
test('own/unknown pieces cannot be reported and duplicate taps enqueue only once', async () => {
  const { controller, port } = reportingSetup();
  await controller.start();
  await controller.reportPhoto('piece', 'other');
  await controller.reportPhoto('unknown', 'other');
  expect(port.call).not.toHaveBeenCalledWith('reportPhoto', expect.anything());
  await Promise.all([
    controller.reportPhoto('other-piece', 'violence'),
    controller.reportPhoto('other-piece', 'sexual'),
  ]);
  expect(
    jest
      .mocked(port.call)
      .mock.calls.filter(([name]) => name === 'reportPhoto'),
  ).toEqual([['reportPhoto', { pieceId: 'other-piece', reason: 'violence' }]]);
});
test('a report completing while backgrounded cannot reveal images and acknowledgement loss is retryable', async () => {
  const { controller, port } = reportingSetup();
  const original = port.call;
  let finish = () => {};
  port.call = jest.fn(async (name, data) => {
    if (name === 'reportPhoto') {
      await original(name, data);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('Acknowledgement lost');
    }
    return original(name, data);
  });
  await controller.start();
  const reporting = controller.reportPhoto('other-piece', 'sexual');
  await flush();
  controller.setAvailable(false);
  finish();
  await reporting;
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    uris: {},
    reportState: 'pending',
  });
  port.call = original;
  await controller.reconnect();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    reportState: 'sent',
  });
  expect(controller.snapshot().uris['other-piece']).toBeUndefined();
});

test('blocking hides the target and releases images before saving, then sends only its piece ID', async () => {
  const { controller, port, release, saved } = reportingSetup('blockPhoto');
  await controller.start();
  const submission = controller.blockPhoto('other-piece');
  expect(
    controller.snapshot().board?.pieces.find((p) => p.id === 'other-piece'),
  ).toMatchObject({
    visibility: 'blank',
    photoRef: null,
    username: null,
    caption: null,
  });
  expect(controller.snapshot().uris).toEqual({});
  expect(release).toHaveBeenCalled();
  await submission;
  expect(port.call).toHaveBeenCalledWith('blockPhoto', {
    pieceId: 'other-piece',
  });
  expect(controller.snapshot().blockState).toBe('sent');
  expect(controller.snapshot().uris['other-piece']).toBeUndefined();
  expect(controller.snapshot().uris.piece).toBeTruthy();
  expect(saved().pendingBlocks).toEqual([]);
});

test('an unsent block survives restart and gates all downloads until the old piece owner has been resolved, including across days', async () => {
  const { controller, port, outage, saved } = reportingSetup('blockPhoto');
  await controller.start();
  outage(true);
  await controller.blockPhoto('other-piece');
  expect(saved().pendingBlocks).toEqual([{ pieceId: 'other-piece' }]);
  expect(controller.snapshot()).toMatchObject({
    phase: 'error',
    blockState: 'pending',
    uris: {},
  });
  controller.stop();
  jest.mocked(port.loadImages).mockClear();
  const original = port.call;
  port.call = jest.fn(async (name, data) =>
    name === 'getDayState'
      ? { ...day, dayKey: '2026-10-11' }
      : original(name, data),
  );
  const restarted = new MobileController(port, 'v1');
  await restarted.start();
  expect(port.loadImages).not.toHaveBeenCalled();
  expect(port.call).not.toHaveBeenCalledWith('getDayState', {});
  expect(restarted.snapshot().blockState).toBe('pending');
  outage(false);
  port.call = original;
  await restarted.pollDay();
  expect(restarted.snapshot().blockState).toBe('sent');
  expect(restarted.snapshot().uris['other-piece']).toBeUndefined();
  expect(saved().pendingBlocks).toEqual([]);
});

test('block storage failure prevents the RPC and duplicate, self and unknown requests do not submit', async () => {
  const { controller, port } = reportingSetup('blockPhoto');
  await controller.start();
  await controller.blockPhoto('piece');
  await controller.blockPhoto('unknown');
  expect(port.call).not.toHaveBeenCalledWith('blockPhoto', expect.anything());
  const save = port.savePreferences;
  port.savePreferences = jest.fn(async () => {
    throw new Error('Synthetic secure storage failure');
  });
  await controller.blockPhoto('other-piece');
  expect(port.call).not.toHaveBeenCalledWith('blockPhoto', expect.anything());
  expect(controller.snapshot().blockState).toBe('pending');
  await controller.reconnect();
  expect(controller.snapshot().uris).toEqual({});
  port.savePreferences = save;
  await Promise.all([controller.retryBlocks(), controller.retryBlocks()]);
  expect(
    jest.mocked(port.call).mock.calls.filter(([name]) => name === 'blockPhoto'),
  ).toHaveLength(1);
});

test('block response loss while backgrounded keeps a durable receipt for retry without showing photos', async () => {
  const { controller, port, saved } = reportingSetup('blockPhoto');
  const original = port.call;
  let finish = () => {};
  port.call = jest.fn(async (name, data) => {
    if (name === 'blockPhoto') {
      await original(name, data);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new Error('Synthetic acknowledgement loss');
    }
    return original(name, data);
  });
  await controller.start();
  const sending = controller.blockPhoto('other-piece');
  await flush();
  controller.setAvailable(false);
  finish();
  await sending;
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    uris: {},
    blockState: 'pending',
  });
  expect(saved().pendingBlocks).toHaveLength(1);
  port.call = original;
  await controller.reconnect();
  expect(controller.snapshot()).toMatchObject({
    phase: 'today',
    blockState: 'sent',
  });
  expect(controller.snapshot().uris['other-piece']).toBeUndefined();
});
