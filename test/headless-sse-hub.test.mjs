import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  isSseKeepaliveEnabled,
  sseHubPaths,
  createSseHubRpcConnection,
  connectSseHubSocket,
  bindHubSseSandbox,
  getBoundHubSandboxId,
  getBoundHubDeviceId,
  clearBoundHubSseSandbox,
  removeStaleSseHubFiles,
  inspectSseHub,
  stopSseHub,
} from '../src/headless-sse-hub.mjs';
import { resolveFrontierKeepaliveEnabled } from '../src/headless.mjs';

test('sse keepalive shares the frontier keepalive kill-switch', () => {
  if (process.platform === 'win32') {
    assert.equal(isSseKeepaliveEnabled({}), false);
    assert.equal(resolveFrontierKeepaliveEnabled({}), false);
    return;
  }
  assert.equal(isSseKeepaliveEnabled({}), true);
  assert.equal(isSseKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: '0' }), false);
  assert.equal(isSseKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: 'off' }), false);
});

test('sse hub bind helpers store sticky sandbox and device', () => {
  clearBoundHubSseSandbox();
  bindHubSseSandbox({ sandboxId: 'hub-sse-1', deviceId: '42' });
  assert.equal(getBoundHubSandboxId(), 'hub-sse-1');
  assert.equal(getBoundHubDeviceId(), '42');
  clearBoundHubSseSandbox();
  assert.equal(getBoundHubSandboxId(), null);
  assert.equal(getBoundHubDeviceId(), null);
});

test('sse hub paths are profile-scoped and distinct from frontier hub', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-sse-hub-paths-'));
  const paths = sseHubPaths({ profile: 'default', configDir: directory });
  assert.match(paths.sockPath, /sse-hub\.sock$/u);
  assert.match(paths.pidPath, /sse-hub\.pid$/u);
  assert.ok(!paths.sockPath.includes('frontier-hub'));
});

test('sse hub RPC supports ping, turn serialisation and accepted events', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-sse-hub-rpc-'));
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
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          const reply = (payload) => connection.write(`${JSON.stringify({ version: 1, type: 'response', id: message.id, ...payload })}\n`);
          if (message.method === 'ping') {
            reply({ ok: true, result: { ok: true, ready: true, sandboxId: 'hub-sse-test', transport: 'sse' } });
            continue;
          }
          if (message.method === 'turn') {
            turns.push(message.params?.options?.args?.[1]);
            connection.write(`${JSON.stringify({ version: 1, type: 'event', id: message.id, event: 'accepted', result: { accepted: true } })}\n`);
            setTimeout(() => reply({ ok: true, result: { status: 'completed', reply: { text: 'ok' } } }), 20);
          }
        }
      });
    });
    server.listen(sockPath, () => resolve());
    server.once('error', reject);
  });
  try {
    const socket = await connectSseHubSocket(sockPath);
    const rpc = createSseHubRpcConnection(socket);
    const ping = await rpc.request('ping', {});
    assert.equal(ping.ready, true);
    assert.equal(ping.sandboxId, 'hub-sse-test');
    let accepted = 0;
    const first = rpc.request('turn', { options: { args: ['sessions', 'create', 'hi'] } }, {
      onEvent: (message) => { if (message.event === 'accepted') accepted += 1; },
    });
    const second = rpc.request('turn', { options: { args: ['sessions', 'send', '1', 'again'] } });
    const results = await Promise.all([first, second]);
    assert.equal(accepted, 1);
    assert.equal(results[0].status, 'completed');
    assert.deepEqual(turns, ['create', 'send']);
    rpc.close();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('inspect/stop report stopped when no sse hub is running', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-sse-hub-inspect-'));
  const status = await inspectSseHub({ profile: 'default', configDir: directory });
  assert.equal(status.running, false);
  assert.equal(status.transport, 'sse');
  const stopped = await stopSseHub({ profile: 'default', configDir: directory });
  assert.equal(stopped.wasRunning, false);
  assert.equal(stopped.transport, 'sse');
  const paths = sseHubPaths({ profile: 'default', configDir: directory });
  const stale = await removeStaleSseHubFiles(paths);
  assert.equal(stale.stale, true);
});
