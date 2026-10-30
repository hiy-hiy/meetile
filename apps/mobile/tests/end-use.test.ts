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
const piece = (id: string, x: number) => ({
  id,
  position: { x, y: 0 },
  edges: {
    north: 'round-out',
    east: 'round-in',
    south: 'square-out',
    west: 'square-in',
  },
  visibility: 'visible',
  photoRef: `normalized/${id}/image`,
  username: '人工署名',
  caption: '人工図形',
});
const board = {
  boardId: 'board',
  dayKey: '2026-10-10',
  version: 1,
  pieces: [piece('piece', 0), piece('other', 1)],
} as BoardView;
type Handler = (data: unknown) => unknown;
function setup(handlers: Record<string, Handler> = {}) {
  const preferences: OwnPreferences = {
    username: '署名',
    legalVersion: 'v1',
    captureId: null,
    draft: null,
  };
  const events: string[] = [];
  const port: MobilePort = {
    initialize: jest.fn(async () => preferences),
    savePreferences: jest.fn(async () => {
      events.push('save');
    }),
    eraseOwnData: jest.fn(async () => {
      events.push('erase');
    }),
    call: jest.fn(async (name: string, data: unknown) => {
      events.push(name);
      const handler = handlers[name];
      if (handler) return handler(data);
      if (name === 'getDayState') return day;
      if (name === 'endUse') return { status: 'ended' };
      if (name === 'reportPhoto') return { status: 'reported' };
      return board;
    }),
    subscribeState: jest.fn(() => () => {}),
    subscribeBoard: jest.fn(() => () => {}),
    loadImages: jest.fn(async () => ({
      uris: { piece: 'file:///private/a.jpg', other: 'file:///private/b.jpg' },
      release: () => {},
    })),
  };
  return {
    controller: new MobileController(port, 'v1'),
    port,
    preferences,
    events,
  };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
test('requests termination with the confirmation literal, then erases the device and stops', async () => {
  const { controller, port, events } = setup();
  await controller.start();
  await controller.endUse();
  expect(port.call).toHaveBeenCalledWith('endUse', { confirm: true });
  expect(events.indexOf('endUse')).toBeLessThan(events.indexOf('erase'));
  expect(controller.snapshot()).toMatchObject({
    phase: 'ended',
    endState: 'done',
    board: null,
    uris: {},
    day: null,
    username: '',
  });
});
test('a failed or unconfirmed request keeps all device data and allows a retry', async () => {
  let fail = true;
  const { controller, port } = setup({
    endUse: () => {
      if (fail) throw new Error('Artificial network failure');
      return { status: 'ended' };
    },
  });
  await controller.start();
  await controller.endUse();
  expect(port.eraseOwnData).not.toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({
    endState: 'failed',
    phase: 'today',
  });
  fail = false;
  await controller.endUse();
  expect(port.eraseOwnData).toHaveBeenCalledTimes(1);
  expect(controller.snapshot().endState).toBe('done');
});
test('a malformed response is not treated as acceptance', async () => {
  const { controller, port } = setup({ endUse: () => ({ status: 'pending' }) });
  await controller.start();
  await controller.endUse();
  expect(port.eraseOwnData).not.toHaveBeenCalled();
  expect(controller.snapshot().endState).toBe('failed');
});
test('double activation sends one termination request', async () => {
  let release: () => void = () => {};
  const { controller, port } = setup({
    endUse: () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 'ended' });
      }),
  });
  await controller.start();
  const first = controller.endUse();
  await flush();
  await controller.endUse();
  release();
  await first;
  const requests = (port.call as jest.Mock).mock.calls.filter(
    ([name]) => name === 'endUse',
  );
  expect(requests).toHaveLength(1);
});
test('unsent reports are flushed first and never erased unsent without confirmation', async () => {
  const { controller, port, events, preferences } = setup();
  preferences.pendingReports = [{ pieceId: 'other', reason: 'other' }];
  await controller.start();
  await controller.endUse();
  expect(events.indexOf('reportPhoto')).toBeLessThan(events.indexOf('endUse'));
  expect(port.eraseOwnData).toHaveBeenCalledTimes(1);
});
test('reports that cannot be sent require explicit discard confirmation', async () => {
  const { controller, port, preferences } = setup({
    reportPhoto: () => {
      throw new Error('Artificial rejection');
    },
  });
  preferences.pendingReports = [{ pieceId: 'other', reason: 'other' }];
  await controller.start();
  await controller.endUse();
  expect(controller.snapshot().endState).toBe('unsent');
  expect(port.call).not.toHaveBeenCalledWith('endUse', expect.anything());
  expect(port.eraseOwnData).not.toHaveBeenCalled();
  await controller.endUse(true);
  expect(port.call).toHaveBeenCalledWith('endUse', { confirm: true });
  expect(controller.snapshot().endState).toBe('done');
});
test('erasure failure after acceptance is reported and can be retried without a second request', async () => {
  const { controller, port } = setup();
  (port.eraseOwnData as jest.Mock).mockRejectedValueOnce(new Error('keychain'));
  await controller.start();
  await controller.endUse();
  expect(controller.snapshot()).toMatchObject({
    phase: 'ended',
    endState: 'erase-failed',
  });
  await controller.retryErase();
  expect(port.eraseOwnData).toHaveBeenCalledTimes(2);
  expect(controller.snapshot().endState).toBe('done');
  expect(
    (port.call as jest.Mock).mock.calls.filter(([name]) => name === 'endUse'),
  ).toHaveLength(1);
});
test('after termination nothing restarts, writes preferences or signs in again', async () => {
  const { controller, port } = setup();
  await controller.start();
  await controller.endUse();
  const initialize = (port.initialize as jest.Mock).mock.calls.length;
  const saves = (port.savePreferences as jest.Mock).mock.calls.length;
  controller.setAvailable(false);
  controller.setAvailable(true);
  await controller.reconnect();
  await controller.start();
  await controller.setUsername('別');
  await controller.pollDay();
  await flush();
  expect(controller.snapshot().phase).toBe('ended');
  expect(port.initialize).toHaveBeenCalledTimes(initialize);
  expect(port.savePreferences).toHaveBeenCalledTimes(saves);
});
test('a queued preference write finishes before erasure so it cannot recreate data', async () => {
  const { controller, port, events } = setup();
  let finish: () => void = () => {};
  (port.savePreferences as jest.Mock).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          events.push('late-save-done');
          resolve();
        };
      }),
  );
  await controller.start();
  const pending = controller.setUsername('新');
  await flush();
  const ending = controller.endUse();
  await flush();
  finish();
  await pending.catch(() => {});
  await ending;
  expect(events.indexOf('late-save-done')).toBeLessThan(
    events.indexOf('erase'),
  );
});
test('report, block and deletion are refused while termination is in flight', async () => {
  let release: () => void = () => {};
  const { controller, port } = setup({
    endUse: () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 'ended' });
      }),
  });
  await controller.start();
  const ending = controller.endUse();
  await flush();
  await controller.reportPhoto('other', 'other');
  await controller.blockPhoto('other');
  await controller.deleteOwnPhoto('piece');
  expect(port.call).not.toHaveBeenCalledWith('reportPhoto', expect.anything());
  expect(port.call).not.toHaveBeenCalledWith('blockPhoto', expect.anything());
  expect(port.call).not.toHaveBeenCalledWith(
    'deleteOwnPhoto',
    expect.anything(),
  );
  release();
  await ending;
});
test('cancel clears a previous failure notice but not an active request', async () => {
  const { controller } = setup({
    endUse: () => {
      throw new Error('Artificial failure');
    },
  });
  await controller.start();
  await controller.endUse();
  expect(controller.snapshot().endState).toBe('failed');
  controller.dismissEndUse();
  expect(controller.snapshot()).toMatchObject({
    endState: 'idle',
    endMessage: '',
  });
});
test('a server refusal is explained distinctly and keeps device data', async () => {
  const { controller, port } = setup({
    endUse: () => {
      throw Object.assign(new Error('refused'), {
        code: 'functions/permission-denied',
      });
    },
  });
  await controller.start();
  await controller.endUse();
  expect(port.eraseOwnData).not.toHaveBeenCalled();
  expect(controller.snapshot().endState).toBe('failed');
  expect(controller.snapshot().endMessage).toContain('受け付けられません');
});
test('losing the connection during the request leaves an offline, retryable state', async () => {
  let controllerRef: { setAvailable: (value: boolean) => void } | null = null;
  let fail = true;
  const { controller, port } = setup({
    endUse: () => {
      if (!fail) return { status: 'ended' };
      fail = false;
      controllerRef?.setAvailable(false);
      throw new Error('Artificial network failure');
    },
  });
  controllerRef = controller;
  await controller.start();
  await controller.endUse();
  expect(port.eraseOwnData).not.toHaveBeenCalled();
  expect(controller.snapshot()).toMatchObject({
    phase: 'offline',
    endState: 'failed',
  });
  controller.setAvailable(true);
  await flush();
  await controller.endUse();
  expect(controller.snapshot().endState).toBe('done');
});
test('a request that cannot be sent now is never ignored silently', async () => {
  const { controller, port } = setup();
  await controller.start();
  controller.setAvailable(false);
  await controller.endUse();
  expect(port.call).not.toHaveBeenCalledWith('endUse', expect.anything());
  expect(controller.snapshot().endState).toBe('failed');
  expect(controller.snapshot().endMessage).toContain('送信できません');
});
test('termination waits for an in-flight report retry, then discards only on confirmation without stale notices', async () => {
  let reject: (() => void) | null = null;
  const { controller, port, preferences } = setup({
    reportPhoto: () => {
      if (reject) throw new Error('Artificial rejection');
      return new Promise((_resolve, fail) => {
        reject = () => fail(new Error('Artificial failure'));
      });
    },
  });
  preferences.pendingReports = [{ pieceId: 'other', reason: 'other' }];
  const starting = controller.start();
  for (let i = 0; i < 50 && !reject; i++) await flush();
  expect(reject).not.toBeNull();
  await controller.endUse(true);
  expect(controller.snapshot().endState).toBe('failed');
  expect(port.call).not.toHaveBeenCalledWith('endUse', expect.anything());
  reject!();
  await starting;
  await controller.endUse();
  expect(controller.snapshot().endState).toBe('unsent');
  await controller.endUse(true);
  expect(controller.snapshot()).toMatchObject({
    phase: 'ended',
    endState: 'done',
    reportState: 'idle',
    reportMessage: '',
  });
});

test('the on-device gallery database is closed before the port erases its folder', async () => {
  const { controller, events } = setup();
  controller.createGallery({
    list: jest.fn(async () => []),
    save: jest.fn(async () => {}),
    claim: jest.fn(async () => {}),
    close: jest.fn(async () => {
      events.push('gallery-close');
    }),
  });
  await controller.start();
  await controller.endUse();
  expect(events.indexOf('gallery-close')).toBeGreaterThan(-1);
  expect(events.indexOf('gallery-close')).toBeLessThan(events.indexOf('erase'));
});
