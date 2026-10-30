import { createServer, createConnection } from 'node:net';
import { chmod, lstat, realpath, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  LOCAL_PROJECT,
  localScenarioSchema,
  LOCAL_PORTS,
} from '../tools/local-development/config.ts';

export async function waitForLocalPorts(
  ports = Object.values(LOCAL_PORTS),
  timeoutMs = 10000,
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const free = await Promise.all(
      ports.map(
        (port) =>
          new Promise((resolveFree) => {
            const server = createServer();
            server.once('error', () => resolveFree(false));
            server.listen(port, '0.0.0.0', () =>
              server.close(() => resolveFree(true)),
            );
          }),
      ),
    );
    if (free.every(Boolean)) return;
    if (Date.now() >= deadline)
      throw new Error(
        'Local emulator ports did not close; no other process was stopped',
      );
    await setTimeout(200);
  }
}

export const resetRequestSchema = z.strictObject({
  action: z.literal('reset'),
  projectId: z.literal(LOCAL_PROJECT),
  runId: z.uuid(),
  scenario: localScenarioSchema.optional(),
});
const responseSchema = z.union([
  z.strictObject({ ok: z.literal(true), runId: z.uuid() }),
  z.strictObject({ ok: z.literal(false) }),
]);

export async function assertRuntimeDirectory(root) {
  if ((await realpath(root)) !== resolve(root))
    throw new Error('Local runtime must not use a symbolic link');
}

// The caller supplies the fixed local-runtime directory, never a CLI path.
export async function assertLocalSnapshotPaths(root) {
  await assertRuntimeDirectory(root);
  for (const name of ['data', 'server-identity.json']) {
    const path = resolve(root, name);
    const stat = await lstat(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat?.isSymbolicLink())
      throw new Error('Local snapshot must not be a symbolic link');
  }
}

export async function deleteLocalSnapshot(root) {
  await assertLocalSnapshotPaths(root);
  await rm(resolve(root, 'data'), { recursive: true, force: true });
  await rm(resolve(root, 'server-identity.json'), { force: true });
}

export async function requestLocalReset(root, request) {
  await assertRuntimeDirectory(root);
  const input = resetRequestSchema.parse(request);
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(resolve(root, 'control.sock'));
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () =>
      socket.destroy(new Error('Reset timed out')),
    );
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(input) + '\n'));
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) socket.destroy(new Error('Invalid reset reply'));
    });
    socket.on('end', () => {
      try {
        const result = responseSchema.parse(JSON.parse(data));
        if (!result.ok) throw new Error('Local server refused reset');
        resolveResponse(result.runId);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function serveLocalControl(root, reset) {
  await assertRuntimeDirectory(root);
  const path = resolve(root, 'control.sock');
  // Only remove an abandoned socket after connecting proves no listener owns it.
  const existing = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid?.())
      throw new Error('Unexpected local control file; no file was removed');
    await new Promise((resolveStale, reject) => {
      const socket = createConnection(path);
      socket.once('connect', () => {
        socket.destroy();
        reject(new Error('Another local server owns the control socket'));
      });
      socket.once('error', (error) => {
        if (error.code === 'ECONNREFUSED') resolveStale();
        else reject(error);
      });
    });
    await rm(path);
  }
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => socket.destroy());
    let data = '';
    let received = false;
    socket.on('data', (chunk) => {
      if (received) return;
      data += chunk;
      if (data.length > 4096) {
        received = true;
        socket.end(JSON.stringify({ ok: false }));
        return;
      }
      if (!data.includes('\n')) return;
      received = true;
      void (async () => {
        try {
          const request = resetRequestSchema.parse(JSON.parse(data));
          const runId = z.uuid().parse(await reset(request));
          socket.end(JSON.stringify({ ok: true, runId }));
        } catch {
          socket.end(JSON.stringify({ ok: false }));
        }
      })();
    });
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(path, resolveReady);
  });
  await chmod(path, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  };
}
