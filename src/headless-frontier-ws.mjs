import os from 'node:os';

const LAUNCH_PATH = '/alice/user/launch';
const REPORT_DEVICE_PATH = '/alice/dispatch/report_device';
const DEFAULT_SUPPORTED_CMDS = [
  100, 200, 201, 300, 400, 500, 501, 502, 503, 504, 600, 700,
  5000, 5001, 6000, 6001, 6002, 6003, 6004, 6005, 10000,
];

/** Desktop Work command-socket tag; required for multi_env fanout on this account. */
export const FRONTIER_CONN_TAG = 'desktop_work';

export async function fetchLaunchConfig(client, { timeoutMs = 15_000 } = {}) {
  const result = await client.json(LAUNCH_PATH, {
    method: 'POST', timeoutMs, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const config = result?.data?.config ?? result?.config ?? result?.data;
  if (!config?.ws_domain || !config?.ws_access_key || !config?.ws_product_id || !config?.ws_app_id) {
    throw new Error('Launch config is missing Frontier websocket fields');
  }
  return config;
}

/**
 * Register this Headless device with LocalHub / dispatcher.
 * Desktop sends enable_ws_multi_env as the string "1" or "0".
 * "1" routes commands to Frontier WS; "0" keeps legacy SSE `/chunk_stream` delivery.
 */
export async function reportMultiEnvDevice(client, {
  deviceName = `${os.hostname()}-headless`,
  deviceType = 'mac',
  osName = 'Mac OS X',
  osVersion = os.release(),
  pcVersion = '2.34.12',
  supportedReqCmds = DEFAULT_SUPPORTED_CMDS,
  enableWsMultiEnv = '1',
  timeoutMs = 15_000,
} = {}) {
  const flag = enableWsMultiEnv === true || enableWsMultiEnv === 1 || enableWsMultiEnv === '1' ? '1' : '0';
  return client.json(REPORT_DEVICE_PATH, {
    method: 'POST', timeoutMs, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_name: deviceName,
      device_type: deviceType,
      os_name: osName,
      os_version: osVersion,
      pc_version: pcVersion,
      supported_req_cmds: supportedReqCmds,
      enable_ws_multi_env: flag,
    }),
  });
}

/** Prefer legacy tool SSE delivery for this device (undo Frontier multi_env registration). */
export async function clearMultiEnvDevice(client, options = {}) {
  return reportMultiEnvDevice(client, { ...options, enableWsMultiEnv: '0' });
}

export function buildFrontierWsUrl(config, {
  deviceId,
  connTag = FRONTIER_CONN_TAG,
  accessKey = config.ws_access_key_v2 || config.ws_access_key,
  identity = 'device_id',
} = {}) {
  if (!deviceId && identity === 'device_id') throw new TypeError('deviceId is required for Frontier device identity');
  const params = {
    device_platform: 'web',
    version_code: 'fws_1.0.0',
    access_key: accessKey,
    fpid: String(config.ws_product_id),
    aid: String(config.ws_app_id),
    xsack: '1',
    xaack: '1',
    'use-olympus-account': '1',
  };
  if (identity === 'device_id') params.device_id = String(deviceId);
  else if (identity === 'ttwid') params.ttwid = decodeURIComponent(config.ttwid || '');
  if (connTag) params.conn_tag = connTag;
  const domain = String(config.ws_domain).replace(/\/$/u, '');
  return `${domain}/ws/v2?${new URLSearchParams(params)}`;
}

export function openFrontierSocket(url, { cookie, origin = 'https://www.doubao.com' } = {}) {
  if (typeof WebSocket !== 'function') throw new Error('WebSocket is unavailable in this runtime');
  return new WebSocket(url, {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: origin,
      Referer: `${origin}/`,
    },
  });
}

/** Extract printable DispatchCommandPayload JSON objects embedded in a Frontier binary frame. */
export function extractDispatchPayloads(buffer) {
  const ascii = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const payloads = [];
  const marker = '"body":{';
  let from = 0;
  while ((from = ascii.indexOf(marker, from)) !== -1) {
    const start = ascii.lastIndexOf('{', from);
    if (start < 0) { from += marker.length; continue; }
    const json = sliceBalancedObject(ascii, start);
    if (!json) { from += marker.length; continue; }
    try {
      const parsed = JSON.parse(json);
      if (parsed?.body?.cmd_call || parsed?.body?.tool_call || parsed?.command != null) payloads.push(parsed);
    } catch {}
    from = start + json.length;
  }
  return payloads;
}

/**
 * Desktop/CDP spinner follows Frontier `agent_task_status` notifies:
 * operation 1 upserts TASK_RUNNING / REPLYING; operation 2 clears them.
 * Clearing the last status for a conversation is when the native UI stops spinning.
 */
export function extractAgentTaskStatusEvents(buffer) {
  const ascii = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const events = [];
  const marker = '"biz_code"';
  let from = 0;
  while ((from = ascii.indexOf(marker, from)) !== -1) {
    const start = ascii.lastIndexOf('{', from);
    if (start < 0) { from += marker.length; continue; }
    const json = sliceBalancedObject(ascii, start);
    if (!json) { from += marker.length; continue; }
    try {
      const parsed = JSON.parse(json);
      const notify = parsed?.downlink_body?.common_cmd_notify || parsed?.common_cmd_notify || parsed;
      if (notify?.biz_code !== 'agent_task_status') { from = start + json.length; continue; }
      let value = notify.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { from = start + json.length; continue; }
      }
      if (!value || typeof value !== 'object') { from = start + json.length; continue; }
      const status = value.status && typeof value.status === 'object' ? value.status : {};
      const meta = value.meta && typeof value.meta === 'object' ? value.meta : {};
      const groupKey = String(status.group_key || '');
      const metaId = String(status.meta_id || meta.meta_id || '');
      const operation = Number(value.operation);
      if (!groupKey || !metaId || ![1, 2].includes(operation)) { from = start + json.length; continue; }
      events.push({
        bizCode: 'agent_task_status',
        operation,
        groupKey,
        metaId,
        conversationId: groupKey.startsWith('conversation:') ? groupKey.slice('conversation:'.length) : '',
        createTimeMs: Number(status.create_time_ms || value.create_timestamp) || undefined,
        updateTimeMs: Number(status.update_time_ms) || undefined,
      });
    } catch {}
    from = start + json.length;
  }
  return events;
}

/** Track Desktop-equivalent agent spinner state per conversation group. */
export function createAgentTaskStatusTracker() {
  const groups = new Map();
  const seen = new Set();
  const settled = new Set();
  const waiters = new Set();

  function notify() {
    for (const waiter of [...waiters]) waiter.check();
  }

  function apply(event) {
    if (!event?.groupKey || !event?.metaId) return;
    let map = groups.get(event.groupKey);
    if (!map) {
      map = new Map();
      groups.set(event.groupKey, map);
    }
    if (event.operation === 1) {
      map.set(event.metaId, event);
      seen.add(event.groupKey);
    } else if (event.operation === 2) {
      map.delete(event.metaId);
      seen.add(event.groupKey);
      // Native UI clears the spinner when REPLYING is removed; TASK_RUNNING may linger.
      if (event.metaId === 'REPLYING' || map.size === 0) settled.add(event.groupKey);
    }
    if (seen.has(event.groupKey) && map.size === 0) settled.add(event.groupKey);
    notify();
  }

  function observeBuffer(buffer) {
    for (const event of extractAgentTaskStatusEvents(buffer)) apply(event);
  }

  function groupKeyFor(conversationId) {
    return `conversation:${String(conversationId || '')}`;
  }

  function isSettled(conversationId) {
    return settled.has(groupKeyFor(conversationId));
  }

  function activeMetaIds(conversationId) {
    const map = groups.get(groupKeyFor(conversationId));
    return map ? [...map.keys()] : [];
  }

  function waitUntilSettled(conversationId, { signal, timeoutMs = 300_000 } = {}) {
    const id = String(conversationId || '');
    if (!id) return Promise.reject(new TypeError('conversationId is required'));
    if (signal?.aborted) {
      return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('Timed out waiting for agent_task_status to settle'), { code: 'timeout' }));
      }, Math.max(1, timeoutMs));
      const onAbort = () => {
        cleanup();
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      const waiter = {
        check() {
          if (!isSettled(id)) return;
          cleanup();
          resolve({ conversationId: id, reason: 'agent_task_status' });
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.check();
    });
  }

  return { apply, observeBuffer, isSettled, activeMetaIds, waitUntilSettled, groupKeyFor };
}

/** Attach a Desktop-style agent_task_status tracker to an open Frontier socket. */
export function attachAgentTaskStatusTracker(socket) {
  if (!socket || typeof socket.addEventListener !== 'function') {
    throw new TypeError('attachAgentTaskStatusTracker requires a WebSocket');
  }
  const tracker = createAgentTaskStatusTracker();
  const onMessage = async (event) => {
    try {
      const raw = event.data;
      const buffer = Buffer.isBuffer(raw) ? raw
        : raw instanceof ArrayBuffer ? Buffer.from(raw)
        : typeof Blob !== 'undefined' && raw instanceof Blob ? Buffer.from(await raw.arrayBuffer())
        : Buffer.from(String(raw ?? ''), 'utf8');
      tracker.observeBuffer(buffer);
    } catch {}
  };
  socket.addEventListener('message', onMessage);
  tracker.detach = () => {
    try { socket.removeEventListener('message', onMessage); } catch {}
  };
  return tracker;
}

function sliceBalancedObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function summarizeDispatchPayload(payload) {
  const call = payload?.body?.tool_call || payload?.body?.cmd_call || {};
  return {
    command: payload?.command ?? call?.type,
    commandId: payload?.command_id || call?.id,
    name: call?.name,
    needAck: call?.need_ack,
    noNeedReply: payload?.no_need_reply,
    sandboxId: call?.agent_meta?.sandbox_id,
    conversationId: call?.agent_meta?.conversation_id,
    hasInput: typeof call?.input === 'string' ? call.input.length : 0,
  };
}

/** Map a Frontier DispatchCommandPayload onto the SSE local-runtime frame shape. */
export function dispatchPayloadToLocalFrame(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tool = payload.body?.tool_call;
  const command = payload.body?.cmd_call;
  const call = tool || command;
  if (!call || typeof call !== 'object') return null;
  const meta = call.agent_meta && typeof call.agent_meta === 'object' ? call.agent_meta : {};
  const sandboxId = String(meta.sandbox_id || '');
  if (tool) {
    if (typeof tool.id !== 'string' || !tool.id || typeof tool.name !== 'string' || !tool.name) return null;
    return {
      event_type: 1,
      sandbox_id: sandboxId,
      tool_call: {
        id: tool.id,
        name: tool.name,
        input: tool.input,
        option: tool.option && typeof tool.option === 'object' ? tool.option : {
          ...(meta.conversation_id ? { conversation_id: meta.conversation_id } : {}),
        },
      },
    };
  }
  if (typeof command.id !== 'string' || !command.id || typeof command.name !== 'string' || !command.name) return null;
  return {
    event_type: 2,
    sandbox_id: sandboxId,
    command: {
      id: command.id,
      name: command.name,
      input: command.input,
      need_ack: command.need_ack === true,
      option: command.option && typeof command.option === 'object' ? command.option : {
        ...(meta.conversation_id ? { conversation_id: meta.conversation_id } : {}),
      },
    },
  };
}

function timingEnabled() {
  return process.env.DOUBAO_HEADLESS_TIMING === '1';
}

function timingMark(label, started) {
  if (!timingEnabled()) return;
  const ms = Date.now() - started;
  console.error(`[headless-timing] ${label} +${ms}ms`);
}

/** Open and await a Frontier command websocket for this Headless device. */
export async function connectFrontierCommandChannel(client, {
  deviceId,
  timeoutMs = 15_000,
  reportDevice = true,
  trackAgentStatus = true,
} = {}) {
  if (typeof client?.json !== 'function' || typeof client?.jar?.header !== 'function') {
    throw new TypeError('Frontier channel requires a HeadlessClient with json() and cookie jar');
  }
  const device = String(deviceId || client.device?.device_id || '');
  if (!device) throw new TypeError('deviceId is required');
  const started = Date.now();
  if (reportDevice) {
    await reportMultiEnvDevice(client, { timeoutMs });
    timingMark('report_device', started);
  }
  const config = await fetchLaunchConfig(client, { timeoutMs });
  timingMark('launch_config', started);
  const cookie = client.jar.header(new URL('https://www.doubao.com/'));
  const url = buildFrontierWsUrl(config, { deviceId: device });
  const socket = openFrontierSocket(url, { cookie });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Frontier command websocket open timeout')), Math.max(1000, timeoutMs));
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  timingMark('frontier_ws_open', started);
  const agentStatus = trackAgentStatus ? attachAgentTaskStatusTracker(socket) : null;
  return { socket, config, deviceId: device, agentStatus };
}
