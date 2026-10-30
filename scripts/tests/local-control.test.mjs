import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  symlink,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { LOCAL_PROJECT } from '../../tools/local-development/config.ts';
import {
  deleteLocalSnapshot,
  requestLocalReset,
  resetRequestSchema,
  serveLocalControl,
  waitForLocalPorts,
} from '../local-control.mjs';

test('restart waits for owned emulator ports to close without terminating their listener', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  let finished = false;
  const waiting = waitForLocalPorts([port], 2000).then(() => {
    finished = true;
  });
  await setTimeout(50);
  assert.equal(finished, false);
  assert.equal(server.listening, true);
  await new Promise((resolve) => server.close(resolve));
  await waiting;
  assert.equal(finished, true);
});

test('only a fixed demo request is accepted; no path or production project can be supplied', () => {
  const valid = {
    action: 'reset',
    projectId: LOCAL_PROJECT,
    runId: randomUUID(),
  };
  for (const invalid of [
    { ...valid, projectId: 'production' },
    { ...valid, root: '/tmp/other' },
    { ...valid, scenario: 'anything' },
    { ...valid, runId: 'invalid' },
  ])
    assert.equal(resetRequestSchema.safeParse(invalid).success, false);
  assert.deepEqual(resetRequestSchema.parse(valid), valid);
});

test('control stays on a private Unix socket, refuses malformed/stale requests and cannot replace a live owner', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'puzzle-control-'));
  const runId = randomUUID();
  const next = randomUUID();
  let resets = 0;
  const close = await serveLocalControl(root, (request) => {
    assert.equal(request.runId, runId);
    resets++;
    return next;
  });
  try {
    assert.equal((await lstat(join(root, 'control.sock'))).mode & 0o777, 0o600);
    await assert.rejects(
      serveLocalControl(root, () => next),
      /Another local server/,
    );
    await assert.rejects(
      requestLocalReset(root, {
        action: 'reset',
        projectId: LOCAL_PROJECT,
        runId: randomUUID(),
      }),
    );
    const reply = await new Promise((resolveReply, reject) => {
      const socket = createConnection(join(root, 'control.sock'));
      let data = '';
      socket.setEncoding('utf8');
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write('{"action":"reset","projectId":"production"}\n'),
      );
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolveReply(JSON.parse(data)));
    });
    assert.deepEqual(reply, { ok: false });
    assert.equal(resets, 0);
    assert.equal(
      await requestLocalReset(root, {
        action: 'reset',
        projectId: LOCAL_PROJECT,
        runId,
        scenario: 'held',
      }),
      next,
    );
    assert.equal(resets, 1);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot reset removes only its two owned entries and refuses symbolic links', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'puzzle-reset-'));
  const unrelated = await mkdtemp(
    join(await realpath(tmpdir()), 'puzzle-unrelated-'),
  );
  try {
    await writeFile(join(unrelated, 'keep'), 'unrelated');
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data', 'fixture'), 'synthetic');
    await writeFile(
      join(root, 'server-identity.json'),
      JSON.stringify(randomUUID()),
    );
    await writeFile(join(root, 'keep'), 'configuration');
    await deleteLocalSnapshot(root);
    assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'configuration');
    await assert.rejects(lstat(join(root, 'data')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(root, 'server-identity.json')), {
      code: 'ENOENT',
    });
    await symlink(unrelated, join(root, 'data'));
    await assert.rejects(deleteLocalSnapshot(root), /symbolic link/);
    assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'unrelated');
    await symlink(unrelated, join(root, 'alias'));
    await assert.rejects(
      deleteLocalSnapshot(join(root, 'alias')),
      /symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});
