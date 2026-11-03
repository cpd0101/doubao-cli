/**
 * Cross-CLI Frontier command-socket hub.
 *
 * One detached process per Headless profile holds the desktop_work WebSocket.
 * CLI create/send turns RPC over a Unix socket so subsequent invokes reuse the
 * warm channel ( empirically ~10s vs ~28s cold reconnect).
 */
import fs from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { configDirectory } from './config.mjs';
import { headlessProfilePaths, validateHeadlessProfileName } from './headless-state.mjs';

const HUB_FILE = fileURLToPath(import.meta.url);
const READY_WAIT_MS = 20_000;
const RPC_VERSION = 1;

/** Module-scoped command socket owned by the hub server process. */
let boundHubSocket = null;
let boundHubDeviceId = null;

export function isFrontierKeepaliveEnabled(env = process.env) {
  if (process.platform === 'win32') return false;
  const raw = String(env?.DOUBAO_HEADLESS_FRONTIER_KEEPALIVE ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

export function frontierHubPaths({ profile = 'default', configDir } = {}) {
  const name = validateHeadlessProfileName(profile);
  const directory = headlessProfilePaths({ profile: name, configDir }).directory;
  return {
    directory,
    sockPath: path.join(directory, 'frontier-hub.sock'),
    pidPath: path.join(directory, 'frontier-hub.pid'),
    logPath: path.join(directory, 'frontier-hub.log'),
  };
}

export function bindHubFrontierSocket(socket, { deviceId } = {}) {
  boundHubSocket = socket;
  boundHubDeviceId = deviceId == null ? null : String(deviceId);
  return socket;
}

export function getBoundHubFrontierSocket() {
  return boundHubSocket;
}

export function getBoundHubDeviceId() {
  return boundHubDeviceId;
}

export function clearBoundHubFrontierSocket() {
  boundHubSocket = null;
  boundHubDeviceId = null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function readPidFile(pidPath) {
  try {
    const raw = (await fs.readFile(pidPath, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeStaleFrontierHubFiles(paths) {
  const pid = await readPidFile(paths.pidPath);
  if (pid && pidAlive(pid)) return { stale: false, pid };
  await fs.rm(paths.sockPath, { force: true });
  await fs.rm(paths.pidPath, { force: true });
  return { stale: true, pid };
}

async function preparePrivateLog(logPath) {
  const absolute = path.resolve(logPath);
  const parent = path.dirname(absolute);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent) throw new Error('Frontier hub log directory resolves through a symlink');
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Frontier hub log path must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fs.open(absolute, flags, 0o600);
  try { await handle.chmod(0o600); }
  catch (error) { await handle.close(); throw error; }
  return { absolute, handle };
}

function encodeFrame(value) {
  return `${JSON.stringify(value)}\n`;
}

export function createFrontierHubRpcConnection(socket) {
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const failAll = (error) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      if (!message || typeof message !== 'object') continue;
      if (message.type === 'event' && pending.has(message.id)) {
        try { pending.get(message.id).onEvent?.(message); } catch {}
        continue;
      }
      if (message.type === 'response' && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok === false) {
          const error = Object.assign(new Error(String(message.error || 'Frontier hub request failed')), {
            code: typeof message.code === 'string' ? message.code : 'FRONTIER_HUB_RPC_FAILED',
          });
          if (message.result && typeof message.result === 'object') error.result = message.result;
          entry.reject(error);
        } else entry.resolve(message.result);
      }
    }
  });
  socket.on('error', error => failAll(Object.assign(new Error('Frontier hub socket error'), { code: 'FRONTIER_HUB_SOCKET_ERROR', cause: error })));
  socket.on('close', () => failAll(Object.assign(new Error('Frontier hub socket closed'), { code: 'FRONTIER_HUB_SOCKET_CLOSED' })));
  return {
    request(method, params = {}, { timeoutMs = 120_000, onEvent } = {}) {
      if (closed) return Promise.reject(Object.assign(new Error('Frontier hub socket closed'), { code: 'FRONTIER_HUB_SOCKET_CLOSED' }));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('Frontier hub request timed out'), { code: 'FRONTIER_HUB_RPC_TIMEOUT' }));
          try { socket.destroy(); } catch {}
        }, Math.max(1_000, timeoutMs));
        pending.set(id, { resolve, reject, timer, onEvent });
        socket.write(encodeFrame({ version: RPC_VERSION, type: 'request', id, method, params }), error => {
          if (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(Object.assign(new Error('Could not write Frontier hub request'), { code: 'FRONTIER_HUB_RPC_WRITE', cause: error }));
          }
        });
      });
    },
    close() {
      failAll(Object.assign(new Error('Frontier hub client closed'), { code: 'FRONTIER_HUB_CLIENT_CLOSED' }));
      try { socket.end(); } catch {}
      try { socket.destroy(); } catch {}
    },
  };
}

export async function connectFrontierHubSocket(sockPath, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('Frontier hub connect timeout'), { code: 'FRONTIER_HUB_CONNECT_TIMEOUT' }));
    }, Math.max(200, timeoutMs));
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Frontier hub connect failed'), { code: 'FRONTIER_HUB_CONNECT_FAILED', cause: error }));
    });
  });
}

async function waitForHubReady(paths, { timeoutMs = READY_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readPidFile(paths.pidPath);
    if (pid && pidAlive(pid) && existsSync(paths.sockPath)) {
      try {
        const socket = await connectFrontierHubSocket(paths.sockPath, { timeoutMs: 1_000 });
        const rpc = createFrontierHubRpcConnection(socket);
        try {
          const ping = await rpc.request('ping', {}, { timeoutMs: 2_000 });
          if (ping?.ok === true || ping?.ready === true) {
            rpc.close();
            return { pid, sockPath: paths.sockPath };
          }
        } catch {
          rpc.close();
        }
      } catch {}
    }
    await sleep(100);
  }
  throw Object.assign(new Error('Frontier hub did not become ready'), { code: 'FRONTIER_HUB_NOT_READY' });
}

export async function spawnFrontierHub({ profile = 'default', configDir = configDirectory(), env = process.env } = {}) {
  const name = validateHeadlessProfileName(profile);
  const paths = frontierHubPaths({ profile: name, configDir });
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const { absolute: logPath, handle } = await preparePrivateLog(paths.logPath);
  const childEnv = {
    ...env,
    DOUBAO_CLI_CONFIG_DIR: path.resolve(configDir),
    DOUBAO_CLI_DISABLE_AUTO_UPDATE: '1',
    DOUBAO_FRONTIER_HUB_SERVER: '1',
  };
  let child;
  try {
    child = spawn(process.execPath, [HUB_FILE, '--frontier-hub', '--profile', name], {
      cwd: path.dirname(HUB_FILE),
      env: childEnv,
      detached: true,
      stdio: ['ignore', 'ignore', handle.fd],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return { pid: child.pid, logPath, ...paths };
}

/** Ensure a live hub for the profile; spawn one if missing. */
export async function ensureFrontierHub({
  profile = 'default',
  configDir = configDirectory(),
  env = process.env,
  readyTimeoutMs = READY_WAIT_MS,
} = {}) {
  if (!isFrontierKeepaliveEnabled(env)) {
    throw Object.assign(new Error('Frontier keepalive is disabled'), { code: 'FRONTIER_HUB_DISABLED' });
  }
  if (process.platform === 'win32') {
    throw Object.assign(new Error('Frontier hub is not supported on Windows'), { code: 'FRONTIER_HUB_UNSUPPORTED' });
  }
  const name = validateHeadlessProfileName(profile);
  const resolvedConfigDir = path.resolve(configDir);
  const paths = frontierHubPaths({ profile: name, configDir: resolvedConfigDir });
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const existing = await removeStaleFrontierHubFiles(paths);
  if (!existing.stale && existing.pid) {
    try {
      return await waitForHubReady(paths, { timeoutMs: Math.min(5_000, readyTimeoutMs) });
    } catch {
      await removeStaleFrontierHubFiles(paths);
    }
  }
  await spawnFrontierHub({ profile: name, configDir: resolvedConfigDir, env });
  return waitForHubReady(paths, { timeoutMs: readyTimeoutMs });
}

function plainJsonOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Frontier hub turn options must be an object');
  }
  const parsed = JSON.parse(JSON.stringify(options));
  if (!Array.isArray(parsed.args) || parsed.args[0] !== 'sessions' || !['create', 'send'].includes(parsed.args[1])) {
    throw new TypeError('Frontier hub requires a headless sessions create/send command');
  }
  return parsed;
}

/** Inspect whether the profile Frontier hub is running (no network login required). */
export async function inspectFrontierHub({
  profile = 'default',
  configDir = configDirectory(),
} = {}) {
  const name = validateHeadlessProfileName(profile);
  const paths = frontierHubPaths({ profile: name, configDir });
  const pid = await readPidFile(paths.pidPath);
  if (!pid || !pidAlive(pid)) {
    await removeStaleFrontierHubFiles(paths);
    return { running: false, pid: null, sockPath: paths.sockPath, pidPath: paths.pidPath };
  }
  let ping = null;
  if (existsSync(paths.sockPath)) {
    try {
      const socket = await connectFrontierHubSocket(paths.sockPath, { timeoutMs: 1_000 });
      const rpc = createFrontierHubRpcConnection(socket);
      try { ping = await rpc.request('ping', {}, { timeoutMs: 2_000 }); }
      finally { rpc.close(); }
    } catch {}
  }
  return {
    running: true,
    pid,
    ready: ping?.ready === true || ping?.ok === true,
    accountId: ping?.accountId || null,
    deviceId: ping?.deviceId || null,
    sockPath: paths.sockPath,
    pidPath: paths.pidPath,
  };
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return !pidAlive(pid);
}

/** Stop the profile Frontier hub if it is running. */
export async function stopFrontierHub({
  profile = 'default',
  configDir = configDirectory(),
} = {}) {
  const name = validateHeadlessProfileName(profile);
  const paths = frontierHubPaths({ profile: name, configDir });
  const before = await inspectFrontierHub({ profile: name, configDir });
  if (!before.running) {
    await removeStaleFrontierHubFiles(paths);
    return { stopped: false, wasRunning: false, pid: null, profile: name };
  }
  const pid = before.pid;
  let method = 'signal';
  if (existsSync(paths.sockPath)) {
    try {
      const socket = await connectFrontierHubSocket(paths.sockPath, { timeoutMs: 1_000 });
      const rpc = createFrontierHubRpcConnection(socket);
      try {
        await rpc.request('shutdown', {}, { timeoutMs: 2_000 });
        method = 'rpc';
      } finally {
        rpc.close();
      }
    } catch {}
  }
  if (!await waitForPidExit(pid, 3_000)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    if (!await waitForPidExit(pid, 2_000)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitForPidExit(pid, 1_000);
    }
    method = method === 'rpc' ? 'rpc+signal' : 'signal';
  }
  await removeStaleFrontierHubFiles(paths);
  return {
    stopped: !pidAlive(pid),
    wasRunning: true,
    pid,
    method,
    profile: name,
  };
}

/** Run one local Frontier turn through the hub. */
export async function callFrontierHubTurn({
  profile = 'default',
  configDir = configDirectory(),
  options,
  fullAccessConfirmed = false,
  expectedAccountId,
  timeoutMs = 120_000,
  env = process.env,
  onAccepted,
} = {}) {
  const safeOptions = plainJsonOptions(options);
  safeOptions.timeoutMs = Math.max(5_000, Number(timeoutMs) || 120_000);
  const hub = await ensureFrontierHub({ profile, configDir, env, readyTimeoutMs: READY_WAIT_MS });
  const socket = await connectFrontierHubSocket(hub.sockPath, { timeoutMs: 5_000 });
  const rpc = createFrontierHubRpcConnection(socket);
  try {
    const result = await rpc.request('turn', {
      options: safeOptions,
      fullAccessConfirmed: fullAccessConfirmed === true,
      expectedAccountId: expectedAccountId == null ? undefined : String(expectedAccountId),
    }, {
      timeoutMs: Math.max(5_000, safeOptions.timeoutMs),
      onEvent: (message) => {
        if (message?.event === 'accepted' && typeof onAccepted === 'function') {
          onAccepted(message.result);
        }
      },
    });
    return { ...result, keepalive: true, hubPid: hub.pid };
  } finally {
    rpc.close();
  }
}

async function writePidFile(pidPath) {
  const temporary = `${pidPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${process.pid}\n`, { mode: 0o600 });
  await fs.rename(temporary, pidPath);
}

async function loadHubClient(profile) {
  const { CookieJar, HeadlessClient } = await import('./headless-http.mjs');
  const credentials = headlessProfilePaths({ profile }).credentials;
  let session;
  try { session = JSON.parse(await fs.readFile(credentials, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Doubao login is required; run "doubao headless login"'), { code: 'login_required' });
    throw new Error('Headless session file is invalid; log in again');
  }
  const cookie = process.env.DOUBAO_HEADLESS_COOKIE;
  const client = new HeadlessClient({
    ...(session || {}),
    ...(cookie ? { cookies: CookieJar.import(cookie), accountId: undefined } : {}),
  });
  client.profile = profile;
  await client.account({ timeoutMs: 15_000 });
  return client;
}

/** Desktop-aligned "hi" keepalive handle for the bound Frontier socket. */
let boundHubKeepalive = null;

async function ensureCommandChannel(client, { deviceId, timeoutMs = 15_000 } = {}) {
  const existing = getBoundHubFrontierSocket();
  if (existing && existing.readyState === 1) return existing;
  if (existing) {
    try { boundHubKeepalive?.stop?.(); } catch {}
    boundHubKeepalive = null;
    try { existing.close?.(); } catch {}
    clearBoundHubFrontierSocket();
  }
  const { connectFrontierCommandChannel, attachFrontierHiKeepalive } = await import('./headless-frontier-ws.mjs');
  const channel = await connectFrontierCommandChannel(client, {
    deviceId, timeoutMs, reportDevice: true, trackAgentStatus: false,
  });
  bindHubFrontierSocket(channel.socket, { deviceId: channel.deviceId || deviceId });
  try { boundHubKeepalive?.stop?.(); } catch {}
  boundHubKeepalive = attachFrontierHiKeepalive(channel.socket, {
    onClose: (reason) => {
      process.stderr.write(`Frontier hub keepalive closed (${reason})\n`);
      if (getBoundHubFrontierSocket() === channel.socket) {
        clearBoundHubFrontierSocket();
        boundHubKeepalive = null;
      }
    },
  });
  channel.socket.addEventListener('close', () => {
    try { boundHubKeepalive?.stop?.(); } catch {}
    if (boundHubKeepalive) boundHubKeepalive = null;
    if (getBoundHubFrontierSocket() === channel.socket) clearBoundHubFrontierSocket();
  });
  return channel.socket;
}

export async function runFrontierHubServer({
  profile = 'default',
  configDir = configDirectory(),
} = {}) {
  const name = validateHeadlessProfileName(profile);
  process.env.DOUBAO_CLI_CONFIG_DIR ||= path.resolve(configDir);
  process.env.DOUBAO_FRONTIER_HUB_SERVER = '1';
  const paths = frontierHubPaths({ profile: name, configDir: process.env.DOUBAO_CLI_CONFIG_DIR });
  await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await removeStaleFrontierHubFiles(paths);

  const client = await loadHubClient(name);
  const deviceId = String(client.device.device_id);
  await ensureCommandChannel(client, { deviceId });

  let shuttingDown = false;
  let turnChain = Promise.resolve();

  const shutdown = async (reason = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.close(); } catch {}
    try { boundHubKeepalive?.stop?.(); } catch {}
    boundHubKeepalive = null;
    const socket = getBoundHubFrontierSocket();
    clearBoundHubFrontierSocket();
    try { socket?.close?.(); } catch {}
    await fs.rm(paths.sockPath, { force: true }).catch(() => {});
    await fs.rm(paths.pidPath, { force: true }).catch(() => {});
    process.stderr.write(`Frontier hub exiting (${reason})\n`);
    process.exit(0);
  };

  const server = net.createServer(connection => {
    let buffer = '';
    connection.setEncoding('utf8');
    const reply = (id, payload) => {
      try { connection.write(encodeFrame({ version: RPC_VERSION, type: 'response', id, ...payload })); }
      catch {}
    };
    const emit = (id, event, result) => {
      try { connection.write(encodeFrame({ version: RPC_VERSION, type: 'event', id, event, result })); }
      catch {}
    };
    connection.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch {
          continue;
        }
        if (!message || message.type !== 'request' || !Number.isInteger(message.id)) continue;
        void handleRequest(message, { emit: (event, result) => emit(message.id, event, result) })
          .then(result => reply(message.id, { ok: true, result }))
          .catch(error => reply(message.id, {
            ok: false,
            error: String(error?.message || error),
            code: typeof error?.code === 'string' ? error.code : 'FRONTIER_HUB_TURN_FAILED',
            ...(error?.result && typeof error.result === 'object' ? { result: error.result } : {}),
          }));
      }
    });
    connection.on('error', () => {});
  });

  async function handleRequest(message, { emit } = {}) {
    if (message.method === 'ping') {
      return { ok: true, ready: true, pid: process.pid, accountId: client.accountId, deviceId };
    }
    if (message.method === 'shutdown') {
      setTimeout(() => { void shutdown('rpc'); }, 10);
      return { ok: true, shuttingDown: true };
    }
    if (message.method !== 'turn') {
      throw Object.assign(new Error(`Unknown Frontier hub method: ${message.method}`), { code: 'FRONTIER_HUB_UNKNOWN_METHOD' });
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const expectedAccountId = params.expectedAccountId == null ? undefined : String(params.expectedAccountId);
    if (expectedAccountId && expectedAccountId !== client.accountId) {
      throw Object.assign(new Error('Headless account changed before Frontier hub turn'), { code: 'account_changed' });
    }
    const run = async () => {
      await ensureCommandChannel(client, { deviceId });
      const { executeHeadless } = await import('./headless.mjs');
      const options = { ...(params.options && typeof params.options === 'object' ? params.options : {}), wait: true, backgroundWorker: true, frontierHubServer: true };
      options.profile = name;
      if (expectedAccountId) options.expectedAccountId = expectedAccountId;
      let acceptedEmitted = false;
      options.onAccepted = (result) => {
        if (acceptedEmitted) return;
        acceptedEmitted = true;
        emit?.('accepted', result);
      };
      const result = await executeHeadless(options, { fullAccessConfirmed: params.fullAccessConfirmed === true });
      return result;
    };
    const queued = turnChain.then(run, run);
    turnChain = queued.then(() => {}, () => {});
    return queued;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.sockPath, () => resolve());
  });
  try { await fs.chmod(paths.sockPath, 0o600); } catch {}
  await writePidFile(paths.pidPath);
  process.stderr.write(`Frontier hub ready pid=${process.pid} profile=${name} sock=${paths.sockPath}\n`);
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

function parseHubArgs(args) {
  if (args[0] !== '--frontier-hub') throw new Error('frontier hub entry requires --frontier-hub');
  let profile = 'default';
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--profile') {
      profile = args[++index];
      continue;
    }
    throw new Error(`Unknown frontier hub argument: ${args[index]}`);
  }
  return { profile: validateHeadlessProfileName(profile || 'default') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === HUB_FILE) {
  const args = process.argv.slice(2);
  if (args[0] === '--frontier-hub') {
    const { profile } = parseHubArgs(args);
    await runFrontierHubServer({ profile }).catch(error => {
      process.stderr.write(`Frontier hub failed: ${error?.message || error}\n`);
      process.exit(1);
    });
  }
}
