import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  isFrontierKeepaliveEnabled,
  frontierHubPaths,
  createFrontierHubRpcConnection,
  connectFrontierHubSocket,
  bindHubFrontierSocket,
  getBoundHubFrontierSocket,
  clearBoundHubFrontierSocket,
  removeStaleFrontierHubFiles,
  inspectFrontierHub,
  stopFrontierHub,
} from '../src/headless-frontier-hub.mjs';
import { parseOptions } from '../src/cli.mjs';
import { executeHeadless } from '../src/headless.mjs';
import { withApp, resolvePlatform } from '../src/app.mjs';
import { resolveFrontierKeepaliveEnabled } from '../src/headless.mjs';
import { HeadlessLocalRuntime } from '../src/headless-local-runtime.mjs';

test('keepalive defaults on for non-win32 and accepts off overrides', () => {
  if (process.platform === 'win32') {
    assert.equal(isFrontierKeepaliveEnabled({}), false);
    assert.equal(resolveFrontierKeepaliveEnabled({}), false);
    return;
  }
  assert.equal(isFrontierKeepaliveEnabled({}), true);
  assert.equal(isFrontierKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: '0' }), false);
  assert.equal(isFrontierKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: 'off' }), false);
  assert.equal(resolveFrontierKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: 'false' }), false);
});

test('ownsSocket false leaves a shared frontier socket open after runtime.close', async () => {
  const conversationId = '1234567890123456';
  let closed = 0;
  const socket = {
    addEventListener() {},
    removeEventListener() {},
    close() { closed += 1; },
  };
  const client = {
    async request() { throw new Error('SSE should not run'); },
    async json() { return {}; },
  };
  const runtime = new HeadlessLocalRuntime({
    client,
    sandboxId: 'sandbox-hub-1',
    deviceId: '123456',
    conversationId,
    workspace: process.cwd(),
    permission: 'FullAccess',
    accountId: '123456',
    transport: 'ws',
    frontierSocket: socket,
    ownsSocket: false,
  });
  const ready = runtime.start();
  await sleep(20);
  await runtime.close();
  await ready.catch(() => {});
  assert.equal(closed, 0);
});

test('ownsSocket true closes the frontier socket from runtime.close', async () => {
  const conversationId = '1234567890123456';
  let closed = 0;
  const socket = {
    addEventListener() {},
    removeEventListener() {},
    close() { closed += 1; },
  };
  const client = {
    async request() { throw new Error('SSE should not run'); },
    async json() { return {}; },
  };
  const runtime = new HeadlessLocalRuntime({
    client,
    sandboxId: 'sandbox-hub-2',
    deviceId: '123456',
    conversationId,
    workspace: process.cwd(),
    permission: 'FullAccess',
    accountId: '123456',
    transport: 'ws',
    frontierSocket: socket,
    ownsSocket: true,
  });
  const ready = runtime.start();
  await sleep(20);
  await runtime.close();
  await ready.catch(() => {});
  assert.ok(closed >= 1);
});

test('hub bind helpers store and clear the shared socket', () => {
  clearBoundHubFrontierSocket();
  const socket = { addEventListener() {}, close() {} };
  bindHubFrontierSocket(socket, { deviceId: '42' });
  assert.equal(getBoundHubFrontierSocket(), socket);
  clearBoundHubFrontierSocket();
  assert.equal(getBoundHubFrontierSocket(), null);
});

test('frontier hub RPC supports ping, turn serialisation and accepted events', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-hub-rpc-'));
  const sockPath = path.join(directory, 'hub.sock');
  const turns = [];
  let server;
  await new Promise((resolve, reject) => {
    server = net.createServer(connection => {
      let buffer = '';
      connection.setEncoding('utf8');
      connection.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const message = JSON.parse(line);
          if (message.method === 'ping') {
            connection.write(`${JSON.stringify({ type: 'response', id: message.id, ok: true, result: { ready: true } })}\n`);
            continue;
          }
          if (message.method === 'turn') {
            turns.push(message.params?.options?.args?.[2] || 'turn');
            connection.write(`${JSON.stringify({ type: 'event', id: message.id, event: 'accepted', result: { accepted: true, status: 'running' } })}\n`);
            setTimeout(() => {
              connection.write(`${JSON.stringify({ type: 'response', id: message.id, ok: true, result: { status: 'completed', reply: { text: 'ok' } } })}\n`);
            }, 30);
          }
        }
      });
    });
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });

  try {
    const socket = await connectFrontierHubSocket(sockPath, { timeoutMs: 2_000 });
    const rpc = createFrontierHubRpcConnection(socket);
    const ping = await rpc.request('ping', {}, { timeoutMs: 2_000 });
    assert.equal(ping.ready, true);

    const accepted = [];
    const first = rpc.request('turn', {
      options: { args: ['sessions', 'create', 'one'] },
    }, {
      timeoutMs: 5_000,
      onEvent: (message) => { if (message.event === 'accepted') accepted.push(message.result); },
    });
    const second = rpc.request('turn', {
      options: { args: ['sessions', 'create', 'two'] },
    }, { timeoutMs: 5_000 });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'completed');
    assert.equal(b.status, 'completed');
    assert.equal(accepted.length, 1);
    assert.deepEqual(turns, ['one', 'two']);
    rpc.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('removeStaleFrontierHubFiles clears sock when pid is dead', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-hub-stale-'));
  const paths = {
    directory,
    sockPath: path.join(directory, 'frontier-hub.sock'),
    pidPath: path.join(directory, 'frontier-hub.pid'),
  };
  await fs.writeFile(paths.pidPath, '99999999\n', { mode: 0o600 });
  await fs.writeFile(paths.sockPath, '', { mode: 0o600 });
  const result = await removeStaleFrontierHubFiles(paths);
  assert.equal(result.stale, true);
  await assert.rejects(() => fs.stat(paths.sockPath), { code: 'ENOENT' });
  await fs.rm(directory, { recursive: true, force: true });
});

test('frontierHubPaths stay under the profile directory', () => {
  const paths = frontierHubPaths({ profile: 'default', configDir: '/tmp/doubao-config' });
  assert.equal(paths.sockPath, path.join('/tmp/doubao-config', 'headless', 'frontier-hub.sock'));
  const named = frontierHubPaths({ profile: 'work', configDir: '/tmp/doubao-config' });
  assert.equal(named.pidPath, path.join('/tmp/doubao-config', 'headless', 'profiles', 'work', 'frontier-hub.pid'));
});

test('inspect and stop report a missing hub without requiring login', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-hub-cmd-'));
  process.env.DOUBAO_CLI_CONFIG_DIR = configDir;
  try {
    const inspected = await inspectFrontierHub({ profile: 'default', configDir });
    assert.equal(inspected.running, false);
    const stopped = await stopFrontierHub({ profile: 'default', configDir });
    assert.equal(stopped.wasRunning, false);
    assert.equal(stopped.stopped, false);
    const status = await withApp(resolvePlatform('headless'), () => executeHeadless(parseOptions(['headless', 'keepalive', 'status', '--json'])));
    assert.equal(status.keepalive.running, false);
    const stop = await withApp(resolvePlatform('headless'), () => executeHeadless(parseOptions(['headless', 'keepalive', 'stop', '--json'])));
    assert.equal(stop.wasRunning, false);
  } finally {
    delete process.env.DOUBAO_CLI_CONFIG_DIR;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
