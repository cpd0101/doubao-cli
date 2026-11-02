import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePermission, DEFAULT_HEADLESS_PERMISSION } from './permissions.mjs';

const SSE_PATH = '/alice/office/tool_local/chunk_stream';
const TOOL_RESULT_PATH = '/alice/office/tool_local/upload_tool_call_result';
const COMMAND_RESULT_PATH = '/alice/office/tool_local/upload_command_result';
const ID = /^[1-9]\d{11,23}$/u;
const MAX_PACKET_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_RECORDED_CALLS = 10_000;
const MAX_WORKSPACE_OPERATIONS = 10_000;
const MAX_DEVICE_ID = 9_223_372_036_854_775_807n;
const MEDIA_EXTENSIONS = new Set(['.bmp', '.gif', '.heic', '.heif', '.jpeg', '.jpg', '.m4a', '.m4v', '.mov', '.mp3', '.mp4', '.ogg', '.png', '.tif', '.tiff', '.wav', '.webm', '.webp']);

function requiredDeviceId(value) {
  const device = requiredString(String(value || ''), 'device id', 64);
  if (!/^\d+$/u.test(device) || BigInt(device) > MAX_DEVICE_ID) {
    throw new TypeError('device id must be an unsigned decimal integer within the signed 64-bit range');
  }
  return device;
}

function requiredString(value, label, maxLength = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function jsonOptions(body, timeoutMs, signal) {
  return { method: 'POST', timeoutMs, signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function localChannelRequestOptions({ sandboxId, deviceId, timeoutMs = 300_000, signal, lastEventId = '' }) {
  const headers = { 'content-type': 'application/json', 'Agw-Js-Conv': 'str' };
  if (lastEventId) headers['last-event-id'] = lastEventId;
  return {
    method: 'POST', timeoutMs, signal,
    params: { sand_box_id: sandboxId, client_version: 'unspecified' },
    headers,
    body: JSON.stringify({ device_id: deviceId, client_attrs: { sandbox_id: sandboxId } }),
  };
}

async function validateSseResponse(response) {
  if (!response || typeof response !== 'object') throw new Error('Local runtime SSE request returned an invalid response');
  const contentType = response.headers?.get?.('content-type') || '';
  if (!response.ok) {
    const error = new Error(`Local runtime SSE connection failed (${response.status})`);
    error.status = response.status;
    try { await response.body?.cancel?.(); } catch {}
    throw error;
  }
  if (!contentType.includes('text/event-stream')) {
    try { await response.body?.cancel?.(); } catch {}
    throw new Error(`Local runtime SSE connection failed (${response.status}: expected event stream)`);
  }
  return response;
}

/** Open the sandbox-scoped SSE request before task completion so the server can bind delivery to the live channel. */
export async function prepareHeadlessLocalChannel(client, { sandboxId, deviceId, timeoutMs = 300_000, signal } = {}) {
  if (typeof client?.request !== 'function') throw new TypeError('runtime client must provide request()');
  const routeId = requiredString(sandboxId, 'sandbox id', 256);
  const device = requiredDeviceId(deviceId);
  const boundedTimeout = Math.max(1000, Math.min(2_147_000_000, timeoutMs));
  const pendingResponse = client.request(SSE_PATH, localChannelRequestOptions({
    sandboxId: routeId, deviceId: device, timeoutMs: boundedTimeout, signal,
  }));
  const response = await abortable(pendingResponse, signal, value => value?.body?.cancel?.());
  if (signal?.aborted) {
    try { await response?.body?.cancel?.(); } catch {}
    throw signal.reason || new DOMException('Aborted', 'AbortError');
  }
  return validateSseResponse(response);
}

function abortable(promise, signal, onLateValue) {
  if (!signal) return promise;
  if (signal.aborted) {
    // The request may already be in flight when its signal flips. Consume its eventual
    // rejection, and cancel any response body that arrives after the caller has left.
    Promise.resolve(promise).then(value => {
      try {
        const cleanup = onLateValue?.(value);
        cleanup?.catch?.(() => {});
      } catch {}
    }, () => {});
    return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      cleanup();
      if (signal.aborted) { onLateValue?.(value); return; }
      resolve(value);
    }, error => { cleanup(); reject(error); });
  });
}

function checkApiReply(reply, operation) {
  if (!reply || typeof reply !== 'object') throw new Error(`${operation} returned an invalid response`);
  if (reply.status_code !== undefined && Number(reply.status_code) !== 0) throw new Error(`${operation} was rejected (${reply.status_code})`);
  if (reply.code !== undefined && Number(reply.code) !== 0) throw new Error(`${operation} was rejected (${reply.code})`);
  if (reply.data?.error_code !== undefined && Number(reply.data.error_code) !== 0) throw new Error(`${operation} was rejected (${reply.data.error_code})`);
  if (reply.data?.code !== undefined && Number(reply.data.code) !== 0) throw new Error(`${operation} was rejected (${reply.data.code})`);
  return reply;
}

function parseJsonInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { input: raw, inputRaw: JSON.stringify(raw) };
  if (typeof raw !== 'string') return { input: {}, inputRaw: '' };
  try {
    const parsed = JSON.parse(raw);
    return { input: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, inputRaw: raw };
  } catch { return { input: {}, inputRaw: raw }; }
}

function conversationFromOption(option, frame = {}) {
  return String(option?.conversation_id ?? option?.conversationId ?? option?.thread_id ?? option?.threadId
    ?? option?.threadid ?? option?.tcid ?? option?.tcId ?? frame.conversation_id ?? '');
}

function parseToolCall(frame) {
  const type = Number(frame?.event_type) === 1 ? 'TOOL_CALL' : frame?.type;
  if (type !== 'TOOL_CALL') return null;
  const tool = Number(frame.event_type) === 1 ? frame.tool_call : (frame.toolCall || frame.tool_call);
  if (!tool || typeof tool !== 'object' || typeof tool.id !== 'string' || !tool.id || typeof tool.name !== 'string' || !tool.name) return null;
  const value = parseJsonInput(tool.input);
  return {
    id: tool.id,
    name: tool.name,
    sandboxId: String(frame.sandbox_id ?? frame.sandBoxID ?? frame.instance_id ?? ''),
    conversationId: conversationFromOption(tool.option, frame),
    input: value.input,
    inputRaw: value.inputRaw,
    option: tool.option && typeof tool.option === 'object' ? tool.option : {},
  };
}

function parseSseFrame(frame) {
  let event = '', id = '', data = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
  }
  if (!data.length) return null;
  return { event, id, data: JSON.parse(data.join('\n')) };
}

async function permissionRisk(permission, toolName, input, workspace) {
  if (permission === 'AlwaysAsk') return 'always-ask';
  if (permission === 'FullAccess') return null;
  if (['Bash', 'Write', 'Edit', 'NotebookEdit', 'connector.call'].includes(toolName)) return 'mutation-or-command';
  const requested = typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path
    : typeof input.notebook_path === 'string' ? input.notebook_path : undefined;
  if (requested && workspace) {
    const absolute = path.resolve(workspace, requested);
    const relative = path.relative(workspace, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'outside-workspace';
    const workspaceReal = await fs.realpath(workspace).catch(() => workspace);
    const resolved = await nearestRealPath(absolute);
    const actualRelative = path.relative(workspaceReal, resolved);
    if (actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) return 'outside-workspace';
  }
  return null;
}

/** Work bootstraps agent state under `.sessions/<conversationId>/` before user tools. */
export function isAgentSessionScaffoldPath(workspaceRelativePath, conversationId) {
  if (typeof workspaceRelativePath !== 'string' || !workspaceRelativePath || typeof conversationId !== 'string' || !ID.test(conversationId)) {
    return false;
  }
  const normalized = workspaceRelativePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalized.split('/').includes('..')) return false;
  const prefix = `.sessions/${conversationId}`;
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

/** AskOnRisk auto-allows session scaffolding; AlwaysAsk still prompts; repo writes stay gated. */
export function workspaceApplyRequiresApproval(permission, operationPath, conversationId) {
  if (permission === 'FullAccess') return false;
  if (permission === 'AlwaysAsk') return true;
  if (isAgentSessionScaffoldPath(operationPath, conversationId)) return false;
  return true;
}

function boundedText(value, maxBytes = MAX_RESULT_BYTES) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString('utf8') + '\n[output truncated]';
}

function toolResult(id, name, text, extra = {}) {
  return { id, name, content: [{ type: 'text', text: boundedText(text) }], isError: false, ...extra };
}

function errorResult(id, name, code, message, extra = {}) {
  return { id, name, content: [{ type: 'text', text: boundedText(message) }], isError: true, error_code: code, error_msg: message, ...extra };
}

function normalizeWorkspaceApplyRequest(raw) {
  const requestId = raw && typeof raw === 'object' && typeof raw.request_id === 'string' ? raw.request_id : '';
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch { return { requestId, error: 'invalid Workspace apply command JSON' }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { requestId, error: 'invalid WorkspaceApplyRequest' };
  const id = typeof value.request_id === 'string' && value.request_id.trim() ? value.request_id : '';
  const workspace = value.workspace;
  if (!id || !workspace || typeof workspace !== 'object' || Array.isArray(workspace)
    || typeof workspace.root !== 'string' || !workspace.root.trim()
    || typeof workspace.session_id !== 'string' || !workspace.session_id.trim()
    || typeof workspace.agent_id !== 'string' || !workspace.agent_id.trim()
    || !Array.isArray(value.operations) || value.operations.length > MAX_WORKSPACE_OPERATIONS) {
    return { requestId: id || requestId, error: 'invalid WorkspaceApplyRequest' };
  }
  const operations = [];
  for (const operation of value.operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)
      || typeof operation.path !== 'string' || !operation.path.trim()) return { requestId: id, error: 'invalid WorkspaceApplyRequest' };
    const item = { type: operation.type, path: operation.path };
    if (item.type === 'write_file') {
      if (!['replace', 'keep', 'append', 'create_only'].includes(operation.mode)) return { requestId: id, error: 'invalid WorkspaceApplyRequest' };
      item.mode = operation.mode;
      item.content = typeof operation.content === 'string' ? operation.content : '';
      if (operation.revision !== undefined) {
        if (!Number.isFinite(operation.revision)) return { requestId: id, error: 'invalid WorkspaceApplyRequest' };
        item.revision = operation.revision;
      }
      if (operation.sequence !== undefined) {
        if (!Number.isFinite(operation.sequence)) return { requestId: id, error: 'invalid WorkspaceApplyRequest' };
        item.sequence = operation.sequence;
      }
    } else if (item.type !== 'ensure_dir' && item.type !== 'ensure_file') {
      return { requestId: id, error: 'invalid WorkspaceApplyRequest' };
    }
    operations.push(item);
  }
  let harnessParams;
  if (Object.hasOwn(value, 'harness_params')) {
    const harness = value.harness_params;
    if (!harness || typeof harness !== 'object' || Array.isArray(harness)
      || typeof harness.session_id !== 'string' || !harness.session_id.trim()
      || typeof harness.attachments_dir !== 'string' || !harness.attachments_dir.trim()
      || !['tool_result_per_tool_size', 'tool_result_head_size', 'tool_result_tail_size', 'tool_result_truncate']
        .every(key => Number.isFinite(harness[key]))) return { requestId: id, error: 'invalid WorkspaceApplyRequest' };
    harnessParams = { ...harness };
  }
  return { request: { request_id: id, workspace: { root: workspace.root, session_id: workspace.session_id, agent_id: workspace.agent_id },
    operations, ...(harnessParams ? { harness_params: harnessParams } : {}) } };
}

function workspaceFailure(requestId, errorCode, errorMessage) {
  return { request_id: requestId || '', status: 'failed', operation_results: [], error_code: errorCode,
    error_message: errorMessage, workspace_ready: false };
}

function lexicalWorkspaceRelativePath(root, input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  const normalized = input.replace(/\\/gu, '/');
  if (normalized.split('/').includes('..') || /^[A-Za-z]:/u.test(normalized) && process.platform !== 'win32') return null;
  const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return { absolute, relative: relative.split(path.sep).join('/') };
}

function toolResultForUpload(result) {
  if (!result || typeof result !== 'object' || typeof result.raw_result === 'string' || result.raw_result === undefined) return result;
  const rawResult = JSON.stringify(result.raw_result);
  if (typeof rawResult !== 'string') throw new TypeError('Local runtime raw_result is not JSON-serializable');
  return { ...result, raw_result: rawResult };
}

function globRegex(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') { i += 1; result += '(?:.*/)?'; } else result += '.*';
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
  }
  return new RegExp(`${result}$`, 'u');
}

async function atomicWriteJson(filePath, value) {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await fs.realpath(parent);
  if (canonicalParent !== parent) throw new Error('Local runtime journal directory resolves through a symlink');
  try {
    const current = await fs.lstat(filePath);
    if (current.isSymbolicLink() || !current.isFile()) throw new Error('Local runtime journal path must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    const directoryHandle = await fs.open(parent, 'r').catch(() => null);
    if (directoryHandle) { await directoryHandle.sync().catch(() => {}); await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function callFingerprint(call) {
  return createHash('sha256').update(`${call.name}\0${call.inputRaw}`, 'utf8').digest('hex');
}

async function nearestRealPath(target) {
  let candidate = target;
  const missing = [];
  while (true) {
    try {
      return path.resolve(await fs.realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

async function readText(file) {
  return fs.readFile(file, 'utf8');
}

function shell(command, { cwd, env, timeoutMs, signal, maxOutputBytes = MAX_RESULT_BYTES }) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let outputBytes = 0;
    const capture = (list, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining) { const part = chunk.subarray(0, remaining); list.push(part); outputBytes += part.length; }
    };
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    let timer;
    let escalationTimer;
    let timedOut = false;
    let aborted = false;
    const killGroup = signalName => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
        return true;
      } catch { return false; }
    };
    const terminate = (reason = 'abort') => {
      clearTimeout(timer);
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      killGroup('SIGTERM');
      clearTimeout(escalationTimer);
      escalationTimer = setTimeout(() => killGroup('SIGKILL'), 300);
    };
    const abort = () => terminate('abort');
    if (timeoutMs > 0) timer = setTimeout(() => terminate('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalationTimer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', (code, signalName) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const descendantsMayRemain = killGroup('SIGTERM');
      if (descendantsMayRemain) {
        clearTimeout(escalationTimer);
        escalationTimer = setTimeout(() => { killGroup('SIGKILL'); resolveResult(); }, 300);
      } else resolveResult();
      function resolveResult() {
        clearTimeout(escalationTimer);
        resolve({ code: Number.isInteger(code) ? code : 1, signal: signalName,
          stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut, aborted: aborted || Boolean(signal?.aborted), truncated: outputBytes >= maxOutputBytes });
      }
    });
  });
}

async function walkFiles(root, options, signal) {
  const results = [];
  const max = Math.min(10_000, Math.max(1, Number(options.maxResults) || 1000));
  const includeDirs = options.includeDirectories === true || options.include_directories === true;
  const includeSymlinks = options.includeSymlinks === true || options.include_symlinks === true;
  const followSymlinks = options.followDirectorySymlinks === true || options.follow_directory_symlinks === true;
  async function visit(directory, relative = '', depth = 0) {
    checkAbort(signal);
    if (depth > 64 || results.length >= max) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      checkAbort(signal);
      if (results.length >= max) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (includeSymlinks) results.push(childRelative);
        if (followSymlinks) {
          let stat;
          try { stat = await fs.stat(child); } catch { continue; }
          if (stat.isDirectory()) await visit(child, childRelative, depth + 1);
        }
      } else if (entry.isDirectory()) {
        if (includeDirs) results.push(childRelative + '/');
        await visit(child, childRelative, depth + 1);
      } else if (entry.isFile()) results.push(childRelative);
    }
  }
  await visit(root);
  return { results, truncated: results.length >= max };
}

export function buildHeadlessLocalTaskParam({ workspace, sandboxId = `route-${randomUUID()}`, deviceId, permission = DEFAULT_HEADLESS_PERMISSION, homeDir = process.env.HOME || process.cwd() } = {}) {
  const resolvedWorkspace = path.resolve(requiredString(workspace, 'workspace'));
  const routeId = requiredString(sandboxId, 'sandbox id', 256);
  const device = requiredDeviceId(deviceId);
  const sandboxAuthType = resolvePermission(permission);
  const generalTaskParam = {
    action: 0,
    thread_local_message_id: [],
    client_option: { enable_sandbox: true, os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : 'Linux',
      shared_folder_path: [resolvedWorkspace], agent_workspace: { agent_workspace: resolvedWorkspace, local_skill_paths: [] },
      client_env_id: '', sandbox_id: routeId, workspace: resolvedWorkspace, sandbox_auth_type: sandboxAuthType },
    runtime_type: 2,
    agent_task_param: { runtime_type: 2, sandbox_auth_type: sandboxAuthType, local_device_id: device, workspace: resolvedWorkspace },
    agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false,
    task_input_json: JSON.stringify({ agents_md: { files: [], state: 2 }, schema_version: 1, home_dir: path.resolve(homeDir), project_context: {} }),
  };
  return { general_task_param: JSON.stringify(generalTaskParam), sandboxAuthType, sandboxId: routeId };
}

/** A portable HTTP/SSE local-tool executor. It does not emulate native app services. */
export class HeadlessLocalRuntime {
  constructor({ client, sandboxId, deviceId, conversationId, workspace, permission = DEFAULT_HEADLESS_PERMISSION, callConnector,
    approve, onReady = () => {}, onError = () => {}, requestTimeoutMs = 300_000, toolTimeoutMs = 120_000,
    maxOutputBytes = MAX_RESULT_BYTES, maxToolCalls = MAX_RECORDED_CALLS, journalPath, accountId, initialResponse } = {}) {
    if (typeof client?.request !== 'function' || typeof client?.json !== 'function') throw new TypeError('runtime client must provide request() and json()');
    this.client = client;
    this.initialResponse = initialResponse;
    this.sandboxId = requiredString(sandboxId, 'sandbox id', 256);
    this.deviceId = requiredDeviceId(deviceId);
    this.conversationId = requiredString(conversationId, 'conversation id', 64);
    if (!ID.test(this.conversationId)) throw new TypeError('conversation id must contain 12 to 24 digits');
    this.workspace = path.resolve(requiredString(workspace, 'workspace'));
    this.permission = String(permission).replace(/[-_]/gu, '').toLowerCase();
    if (!['alwaysask', 'askonrisk', 'fullaccess'].includes(this.permission)) resolvePermission(permission);
    this.permissionName = this.permission === 'alwaysask' ? 'AlwaysAsk' : this.permission === 'askonrisk' ? 'AskOnRisk' : 'FullAccess';
    this.callConnector = callConnector;
    this.approve = approve;
    this.onReady = onReady;
    this.onError = onError;
    this.requestTimeoutMs = Math.max(1000, Math.min(2_147_000_000, requestTimeoutMs));
    this.toolTimeoutMs = Math.max(1, Math.min(600_000, toolTimeoutMs));
    this.maxOutputBytes = Math.max(1024, Math.min(MAX_RESULT_BYTES, maxOutputBytes));
    this.maxToolCalls = Math.max(1, Math.min(MAX_RECORDED_CALLS, maxToolCalls));
    this.journalPath = journalPath ? path.resolve(requiredString(journalPath, 'journal path', 4096)) : undefined;
    this.accountId = accountId == null ? undefined : requiredString(accountId, 'account id', 128);
    if (this.journalPath && !this.accountId) throw new TypeError('account id is required for a journal-scoped local runtime');
    this.leasePath = this.journalPath ? `${this.journalPath}.lock` : undefined;
    this.leaseToken = null;
    this.leaseDirectoryIdentity = null;
    this.lastEventId = '';
    this.records = new Map();
    this.journalReady = this.journalPath ? this.loadJournal() : Promise.resolve();
    this.state = 'idle';
    this.controller = new AbortController();
    this.reader = null;
    this.loopPromise = null;
    this.externalSignal = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
  }

  async start({ signal } = {}) {
    if (this.state !== 'idle') throw new Error('Headless local runtime can only be started once');
    try {
      await this.journalReady;
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      await this.acquireLease();
    } catch (error) {
      try { await this.initialResponse?.body?.cancel?.(); } catch {}
      this.initialResponse = null;
      throw error;
    }
    this.externalSignal = signal;
    this.externalAbort = () => this.close(signal.reason);
    signal?.addEventListener('abort', this.externalAbort, { once: true });
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.state = 'connecting';
    this.loopPromise = this.runLoop();
    this.loopPromise.catch(error => { this.onError(error); if (!this.readySettled) this.readyReject(error); });
    return this.readyPromise;
  }

  async close(reason = new DOMException('Stopped', 'AbortError')) {
    if (this.state === 'closed') {
      if (!this.controller.signal.aborted) this.controller.abort(reason);
      try { await this.reader?.cancel(reason); } catch {}
      await this.loopPromise?.catch(() => {});
      this.reader = null;
      try { await this.initialResponse?.body?.cancel?.(); } catch {}
      this.initialResponse = null;
      this.externalSignal?.removeEventListener('abort', this.externalAbort);
      await this.releaseLease().catch(error => { try { this.onError(error); } catch {} });
      return;
    }
    this.state = 'closing';
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    try { await this.reader?.cancel(reason); } catch {}
    try { await this.initialResponse?.body?.cancel?.(reason); } catch {}
    this.initialResponse = null;
    this.externalSignal?.removeEventListener('abort', this.externalAbort);
    await this.loopPromise?.catch(() => {});
    this.reader = null;
    this.state = 'closed';
    await this.releaseLease().catch(error => { try { this.onError(error); } catch {} });
  }

  leaseScope() {
    return { accountId: this.accountId, sandboxId: this.sandboxId, deviceId: this.deviceId, conversationId: this.conversationId };
  }

  matchesFrameIdentity(frame) {
    // The desktop's native signature envelope includes these identity fields. Check them
    // against the account/device bound to this locally issued sandbox; no crypto verifier
    // is implemented here, so transport authentication and sandbox scoping remain primary.
    if (frame.signature === undefined) return true;
    const signature = frame.signature;
    if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return false;
    if (signature.device_id !== undefined
      && (typeof signature.device_id !== 'string' || signature.device_id !== this.deviceId)) return false;
    if (signature.user_id !== undefined
      && (typeof signature.user_id !== 'string' || !this.accountId || signature.user_id !== this.accountId)) return false;
    return true;
  }

  async readLease() {
    let stat;
    try { stat = await fs.lstat(this.leasePath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new Error('Local runtime lease must be a private directory; legacy or unsafe lease requires manual cleanup');
    }
    const names = await fs.readdir(this.leasePath);
    if (names.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/u.test(names[0])) {
      const error = new Error('Local runtime lease is incomplete or contains multiple owners; refusing unsafe recovery');
      error.code = 'LOCAL_RUNTIME_BUSY';
      throw error;
    }
    const ownerPath = path.join(this.leasePath, names[0]);
    const ownerStat = await fs.lstat(ownerPath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || (ownerStat.mode & 0o077) !== 0 || ownerStat.size > 4096) {
      throw new Error('Local runtime lease owner is unsafe or invalid');
    }
    let lease;
    try { lease = JSON.parse(await fs.readFile(ownerPath, 'utf8')); }
    catch { throw new Error('Local runtime lease is unreadable or invalid'); }
    if (!lease || lease.version !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1
      || typeof lease.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(lease.token)
      || names[0] !== `owner-${lease.token}.json`
      || Object.entries(this.leaseScope()).some(([key, value]) => lease[key] !== value)) {
      throw new Error('Local runtime lease belongs to a different account or runtime scope');
    }
    return { lease, ownerPath, directoryIdentity: { dev: stat.dev, ino: stat.ino } };
  }

  async acquireLease() {
    if (!this.leasePath) return;
    const parent = path.dirname(this.leasePath);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    if (await fs.realpath(parent) !== parent) throw new Error('Local runtime lease directory resolves through a symlink');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      const stagedDirectory = path.join(parent, `.${path.basename(this.leasePath)}.${token}.tmp`);
      const ownerPath = path.join(stagedDirectory, `owner-${token}.json`);
      try {
        await fs.mkdir(stagedDirectory, { mode: 0o700 });
        const directoryStat = await fs.lstat(stagedDirectory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Local runtime lease staging directory is unsafe');
        const value = { version: 1, ...this.leaseScope(), pid: process.pid, token };
        const handle = await fs.open(ownerPath, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        // Publish the fully initialized directory atomically. This avoids a visible empty
        // lock window if the process exits between lock creation and owner-file creation.
        await fs.rename(stagedDirectory, this.leasePath);
        const verified = await fs.lstat(this.leasePath);
        if (!verified.isDirectory() || verified.isSymbolicLink() || verified.dev !== directoryStat.dev || verified.ino !== directoryStat.ino) {
          throw new Error('Local runtime lease directory changed during acquisition');
        }
        this.leaseToken = token;
        this.leaseDirectoryIdentity = { dev: verified.dev, ino: verified.ino };
        return;
      } catch (error) {
        await fs.rm(stagedDirectory, { recursive: true, force: true }).catch(() => {});
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }

      const existing = await this.readLease();
      if (!existing) continue;
      let ownerAlive = true;
      try { process.kill(existing.lease.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') ownerAlive = false;
        else if (error.code !== 'EPERM') throw error;
      }
      if (ownerAlive) {
        const error = new Error('A headless local runtime already owns this journal');
        error.code = 'LOCAL_RUNTIME_BUSY';
        throw error;
      }
      const rechecked = await this.readLease();
      if (!rechecked || rechecked.lease.token !== existing.lease.token
        || rechecked.directoryIdentity.dev !== existing.directoryIdentity.dev
        || rechecked.directoryIdentity.ino !== existing.directoryIdentity.ino) continue;
      try {
        // Only the contender that atomically removes this unique stale owner may attempt
        // to remove the now-empty directory. Other contenders cannot delete a replacement.
        await fs.unlink(existing.ownerPath);
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try { await fs.rmdir(this.leasePath); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
    }
    const error = new Error('A headless local runtime already owns this journal');
    error.code = 'LOCAL_RUNTIME_BUSY';
    throw error;
  }

  async releaseLease() {
    if (!this.leasePath || !this.leaseToken) return;
    const token = this.leaseToken;
    this.leaseToken = null;
    const directoryIdentity = this.leaseDirectoryIdentity;
    this.leaseDirectoryIdentity = null;
    const current = await this.readLease().catch(() => null);
    if (current?.lease.token !== token || current.directoryIdentity.dev !== directoryIdentity?.dev
      || current.directoryIdentity.ino !== directoryIdentity?.ino) return;
    await fs.unlink(current.ownerPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(this.leasePath).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
  }

  async loadJournal() {
    const parent = path.dirname(this.journalPath);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    if (await fs.realpath(parent) !== parent) throw new Error('Local runtime journal directory resolves through a symlink');
    let stat;
    try { stat = await fs.lstat(this.journalPath); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Local runtime journal path must be a regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('Local runtime journal permissions must be 0600');
    if (stat.size > 8 * 1024 * 1024) throw new Error('Local runtime journal exceeds the size limit');
    const journal = JSON.parse(await fs.readFile(this.journalPath, 'utf8'));
    const scope = { accountId: this.accountId, sandboxId: this.sandboxId, deviceId: this.deviceId, conversationId: this.conversationId };
    if (!journal || journal.version !== 1 || Object.entries(scope).some(([key, value]) => journal[key] !== value)) {
      throw new Error('Local runtime journal belongs to a different account or runtime scope');
    }
    this.lastEventId = typeof journal.lastEventId === 'string' ? journal.lastEventId : '';
    if (this.lastEventId.length > 1024) throw new Error('Local runtime journal has an invalid event cursor');
    if (!Array.isArray(journal.records) || journal.records.length > this.maxToolCalls) throw new Error('Local runtime journal has invalid call records');
    for (const entry of journal.records) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || !/^[a-f0-9]{64}$/u.test(entry.inputFingerprint)
        || !['started', 'upload_failed', 'uploaded'].includes(entry.status)
        || (entry.status !== 'started' && (!entry.result || typeof entry.result !== 'object'))) {
        throw new Error('Local runtime journal contains an invalid call record');
      }
      if (this.records.has(entry.id)) throw new Error('Local runtime journal contains duplicate call ids');
      this.records.set(entry.id, { status: entry.status, inputFingerprint: entry.inputFingerprint,
        result: entry.result ?? null, recovered: true });
    }
  }

  async persistJournal() {
    if (!this.journalPath) return;
    const records = [...this.records].map(([id, record]) => ({ id, status: record.status,
      inputFingerprint: record.inputFingerprint, ...(record.result ? { result: record.result } : {}) }));
    const scope = { accountId: this.accountId, sandboxId: this.sandboxId, deviceId: this.deviceId, conversationId: this.conversationId };
    await atomicWriteJson(this.journalPath, { version: 1, ...scope, lastEventId: this.lastEventId, records });
  }

  async runLoop() {
    await this.journalReady;
    let delayMs = 250;
    while (!this.controller.signal.aborted) {
      let response;
      try {
        if (this.initialResponse) {
          response = this.initialResponse;
          this.initialResponse = null;
        } else {
          const pendingResponse = this.client.request(SSE_PATH, localChannelRequestOptions({
            sandboxId: this.sandboxId, deviceId: this.deviceId, timeoutMs: this.requestTimeoutMs,
            signal: this.controller.signal, lastEventId: this.lastEventId,
          }));
          response = await abortable(pendingResponse, this.controller.signal, value => value?.body?.cancel?.());
        }
        if (this.controller.signal.aborted) { await response.body?.cancel?.(); break; }
        response = await validateSseResponse(response);
        this.state = 'ready';
        delayMs = 250;
        if (!this.readySettled) {
          this.readySettled = true;
          this.readyResolve({ ready: true, transport: 'http-sse', sandboxId: this.sandboxId, conversationId: this.conversationId });
          await this.onReady({ sandboxId: this.sandboxId, conversationId: this.conversationId, transport: 'http-sse' });
        }
        await this.consume(response);
        if (!this.controller.signal.aborted) throw new Error('Local runtime SSE stream ended');
      } catch (error) {
        if (this.controller.signal.aborted) break;
        if (response && !response.ok) { try { await response.body?.cancel?.(); } catch {} }
        if (error?.code === 'login_required' || Number(error?.status) >= 400 && Number(error?.status) < 500
          && ![408, 429].includes(Number(error.status))) {
          this.state = 'failed';
          if (!this.readySettled) {
            this.readySettled = true;
            this.readyReject(error);
          }
          try { this.onError(error); } catch {}
          break;
        }
        this.state = 'reconnecting';
        this.onError(error);
        await this.wait(delayMs);
        delayMs = Math.min(30_000, delayMs * 2);
      }
    }
    if (!this.readySettled && this.controller.signal.aborted) this.readyReject(this.controller.signal.reason || new Error('Local runtime stopped before connecting'));
    if (!['closing', 'closed'].includes(this.state)) this.state = 'closed';
  }

  wait(milliseconds) {
    return new Promise(resolve => {
      if (this.controller.signal.aborted) return resolve();
      let timer;
      const done = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener('abort', done);
        resolve();
      };
      timer = setTimeout(done, milliseconds);
      this.controller.signal.addEventListener('abort', done, { once: true });
    });
  }

  async consume(response) {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('Local runtime SSE response has no body');
    this.reader = reader;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!this.controller.signal.aborted) {
        const part = await reader.read();
        buffer += decoder.decode(part.value, { stream: !part.done });
        if (Buffer.byteLength(buffer) > MAX_PACKET_BYTES) throw new Error('Local runtime SSE frame exceeds the size limit');
        let delimiter;
        while ((delimiter = /\r?\n\r?\n/u.exec(buffer))) {
          const raw = buffer.slice(0, delimiter.index);
          buffer = buffer.slice(delimiter.index + delimiter[0].length);
          let packet;
          try { packet = parseSseFrame(raw); } catch { continue; }
          if (!packet) continue;
          await this.handleFrame(packet.data);
          if (packet.id) {
            this.lastEventId = packet.id;
            await this.persistJournal();
          }
        }
        if (part.done) return;
      }
    } finally {
      if (this.reader === reader) this.reader = null;
      await reader.cancel().catch(() => {});
    }
  }

  async handleFrame(frame) {
    await this.journalReady;
    if (!frame || typeof frame !== 'object') return;
    const eventType = Number(frame.event_type);
    const kind = eventType === 1 ? 'TOOL_CALL' : eventType === 2 ? 'COMMAND' : eventType === 3 ? 'HEARTBEAT' : frame.type;
    if (kind === 'HEARTBEAT') return;
    if ((kind === 'TOOL_CALL' || kind === 'COMMAND') && !this.matchesFrameIdentity(frame)) return;
    if (kind === 'COMMAND') return this.handleCommand(frame.command, frame);
    if (kind !== 'TOOL_CALL') return;
    const call = parseToolCall(frame);
    if (!call) return;
    if (call.sandboxId !== this.sandboxId) return;
    // The native SSE event binds through the locally issued sandbox id; conversation_id
    // is absent from the real tool_call.option. Reject it only when the service supplies it.
    if (call.conversationId && call.conversationId !== this.conversationId) return;
    call.inputFingerprint = callFingerprint(call);
    if (!this.records.has(call.id) && this.records.size >= this.maxToolCalls) {
      await this.uploadToolResult(call, errorResult(call.id, call.name, 'TOOL_QUEUE_FULL', 'Local runtime call limit reached; the tool was not executed.'));
      return;
    }
    const existing = this.records.get(call.id);
    if (existing) {
      if (existing.inputFingerprint !== call.inputFingerprint) {
        this.onError(new Error(`Local runtime tool id collision: ${call.id}`));
        return;
      }
      if (existing.status === 'upload_failed') await this.uploadToolResult(call, existing.result, existing);
      else if (existing.status === 'started' && existing.recovered) {
        const result = errorResult(call.id, call.name, 'TOOL_OUTCOME_UNCONFIRMED', 'A previous process may have executed this tool before stopping; it was not rerun.');
        existing.result = result;
        existing.status = 'upload_failed';
        await this.persistJournal();
        await this.uploadToolResult(call, result, existing);
      }
      return;
    }
    const record = { status: 'started', inputFingerprint: call.inputFingerprint, result: null, recovered: false };
    this.records.set(call.id, record);
    await this.persistJournal();
    const result = await this.execute(call).catch(error => errorResult(call.id, call.name, 'TOOL_EXECUTION_FAILED', `Local tool execution failed: ${error.message || error}`));
    record.result = result;
    record.status = 'upload_failed';
    await this.persistJournal();
    await this.uploadToolResult(call, result, record);
  }

  async uploadToolResult(call, result, record = this.records.get(call.id)) {
    if (record?.status === 'uploaded') return;
    const body = { sandbox_id: this.sandboxId, device_id: this.deviceId, tool_result: toolResultForUpload(result) };
    try {
      checkApiReply(await this.client.json(TOOL_RESULT_PATH, jsonOptions(body, this.toolTimeoutMs, this.controller.signal)), 'Local runtime result upload');
      if (record) { record.result = body.tool_result; record.status = 'uploaded'; record.recovered = false; await this.persistJournal(); }
    } catch (error) {
      if (record) record.status = 'upload_failed';
      await this.persistJournal().catch(this.onError);
      this.onError(error);
      throw error;
    }
  }

  async handleCommand(command, frame) {
    if (!command || typeof command !== 'object' || typeof command.id !== 'string' || !command.id) return;
    const routed = String(frame.sandbox_id ?? frame.sandBoxID ?? frame.instance_id ?? '');
    if (routed !== this.sandboxId) return;
    const suppliedConversationId = conversationFromOption(command.option, frame);
    if (suppliedConversationId && suppliedConversationId !== this.conversationId) return;
    const needAck = command.need_ack === true;
    if (command.name !== 'local.workspace.apply') {
      if (needAck) {
        const result = { device_id: this.deviceId, command_result: { id: command.id, code: 1,
          message: 'This portable CLI runtime does not implement native sandbox lifecycle commands.' } };
        checkApiReply(await this.client.json(COMMAND_RESULT_PATH, jsonOptions(result, this.toolTimeoutMs, this.controller.signal)), 'Local runtime command acknowledgement');
      }
      return;
    }

    const inputRaw = typeof command.inputRaw === 'string' ? command.inputRaw
      : typeof command.input === 'string' ? command.input : JSON.stringify(command.input ?? {});
    const inputFingerprint = createHash('sha256').update(`${command.name}\0${inputRaw}\0${needAck ? '1' : '0'}`, 'utf8').digest('hex');
    const recordKey = `command:${command.id}`;
    const prior = this.records.get(recordKey);
    if (prior) {
      if (prior.inputFingerprint !== inputFingerprint) {
        this.onError(new Error(`Local runtime command id collision: ${command.id}`));
        return;
      }
      if (prior.status === 'upload_failed') await this.uploadCommandResult(command.id, prior.result, prior, needAck);
      else if (prior.status === 'started' && prior.recovered) {
        const parsed = normalizeWorkspaceApplyRequest(command.inputRaw ?? command.input);
        const workspaceApplyResponse = workspaceFailure(parsed.request?.request_id || parsed.requestId, 'COMMAND_OUTCOME_UNCONFIRMED',
          'A previous process may have applied workspace changes before stopping; the operations were not rerun.');
        prior.result = this.commandUploadPayload(command.id, false, workspaceApplyResponse.error_message, workspaceApplyResponse);
        prior.status = needAck ? 'upload_failed' : 'uploaded';
        await this.persistJournal();
        if (needAck) await this.uploadCommandResult(command.id, prior.result, prior, needAck);
      }
      return;
    }

    const record = { status: 'started', inputFingerprint, result: null, recovered: false };
    this.records.set(recordKey, record);
    await this.persistJournal();
    const applied = await this.applyWorkspaceRequest(command).catch(error => ({ success: false,
      response: workspaceFailure('', error.code || 'NATIVE_API_CALL_FAILED', 'Workspace apply failed unexpectedly.') }));
    record.result = this.commandUploadPayload(command.id, applied.success, applied.response.error_message, applied.response);
    record.status = needAck ? 'upload_failed' : 'uploaded';
    await this.persistJournal();
    if (needAck) await this.uploadCommandResult(command.id, record.result, record, true);
  }

  commandUploadPayload(commandId, success, message, workspaceApplyResponse) {
    return { device_id: this.deviceId, command_result: { id: commandId, code: success ? 0 : 1,
      ...(message ? { message } : {}) }, workspace_apply_response: workspaceApplyResponse };
  }

  async uploadCommandResult(commandId, result, record, needAck = true) {
    if (!needAck) { if (record) { record.status = 'uploaded'; await this.persistJournal(); } return; }
    if (record?.status === 'uploaded') return;
    try {
      checkApiReply(await this.client.json(COMMAND_RESULT_PATH, jsonOptions(result, this.toolTimeoutMs, this.controller.signal)), 'Local runtime command result upload');
      if (record) { record.status = 'uploaded'; record.recovered = false; await this.persistJournal(); }
    } catch (error) {
      if (record) record.status = 'upload_failed';
      await this.persistJournal().catch(this.onError);
      this.onError(error);
      throw error;
    }
  }

  async applyWorkspaceRequest(command) {
    const raw = command.inputRaw ?? command.input;
    if (typeof raw === 'string' && Buffer.byteLength(raw) > MAX_PACKET_BYTES) {
      const response = workspaceFailure('', 'INVALID_REQUEST', 'Workspace apply request exceeds the size limit.');
      return { success: false, response };
    }
    const parsed = normalizeWorkspaceApplyRequest(raw);
    if (parsed.error) return { success: false, response: workspaceFailure(parsed.requestId, 'INVALID_REQUEST', parsed.error) };
    const request = parsed.request;
    if (!request.workspace.agent_id || !request.workspace.session_id
      || command.option?.agent_id && command.option.agent_id !== request.workspace.agent_id) {
      return { success: false, response: workspaceFailure(request.request_id, 'INVALID_REQUEST', 'invalid workspace agent/session identity') };
    }
    let configuredRoot;
    let suppliedRoot;
    try {
      configuredRoot = await fs.realpath(this.workspace);
      suppliedRoot = await fs.realpath(path.resolve(request.workspace.root));
    } catch {
      return { success: false, response: workspaceFailure(request.request_id, 'INVALID_REQUEST', 'workspace root is unavailable') };
    }
    if (!path.isAbsolute(request.workspace.root) || suppliedRoot !== configuredRoot) {
      return { success: false, response: workspaceFailure(request.request_id, 'INVALID_REQUEST', 'workspace root does not match the owned workspace') };
    }
    if (request.harness_params) {
      if (request.harness_params.session_id !== request.workspace.session_id
        || request.harness_params.sandbox_id && request.harness_params.sandbox_id !== this.sandboxId) {
        return { success: false, response: workspaceFailure(request.request_id, 'INVALID_REQUEST', 'invalid workspace harness identity') };
      }
      const attachmentsPath = lexicalWorkspaceRelativePath(configuredRoot, request.harness_params.attachments_dir);
      if (!attachmentsPath || !this.isPathWithinWorkspace(configuredRoot, await nearestRealPath(attachmentsPath.absolute))) {
        return { success: false, response: workspaceFailure(request.request_id, 'INVALID_REQUEST', 'attachments directory escapes workspace root') };
      }
    }

    const operationResults = [];
    for (const [index, operation] of request.operations.entries()) {
      checkAbort(this.controller.signal);
      const resolved = lexicalWorkspaceRelativePath(configuredRoot, operation.path);
      if (!resolved) {
        operationResults.push({ operation_index: index, path: operation.path, status: 'failed',
          error_code: 'PATH_OUTSIDE_WORKSPACE', error_message: 'operation path escapes workspace root' });
        continue;
      }
      let actual;
      try { actual = await nearestRealPath(resolved.absolute); }
      catch {
        operationResults.push({ operation_index: index, path: operation.path, status: 'failed',
          error_code: 'PATH_OUTSIDE_WORKSPACE', error_message: 'operation path escapes workspace root' });
        continue;
      }
      if (!this.isPathWithinWorkspace(configuredRoot, actual)) {
        operationResults.push({ operation_index: index, path: operation.path, status: 'failed',
          error_code: 'PATH_OUTSIDE_WORKSPACE', error_message: 'operation path escapes workspace root' });
        continue;
      }
      const operationResult = await this.applyWorkspaceOperation(operation, resolved.absolute, index);
      operationResults.push(operationResult);
    }
    const failures = operationResults.filter(result => result.status === 'failed');
    if (!failures.length) return { success: true, response: { request_id: request.request_id, status: 'success',
      operation_results: operationResults, workspace_ready: true } };
    const first = failures[0];
    const status = failures.length === operationResults.length ? 'failed' : 'partial_success';
    return { success: false, response: { request_id: request.request_id, status, operation_results: operationResults,
      error_code: status === 'failed' ? first.error_code : 'PARTIAL_FAILURE',
      error_message: `${failures.length} of ${operationResults.length} operations failed`, workspace_ready: false,
      failed_entry: first.path } };
  }

  isPathWithinWorkspace(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  /** Create missing parents for file ops. Live Work can send append/write before init_agent_workspace. */
  async ensureWorkspaceParentDirectory(target) {
    const parent = path.dirname(target);
    if (!parent || parent === target) return;
    const workspaceRoot = await fs.realpath(this.workspace);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const parentReal = await fs.realpath(parent);
    if (!this.isPathWithinWorkspace(workspaceRoot, parentReal)) {
      const error = new Error('parent directory escapes workspace root');
      error.code = 'PATH_OUTSIDE_WORKSPACE';
      throw error;
    }
  }

  async applyWorkspaceOperation(operation, target, operationIndex) {
    if (workspaceApplyRequiresApproval(this.permissionName, operation?.path, this.conversationId)) {
      let approved = false;
      if (typeof this.approve === 'function') {
        approved = await abortable(Promise.resolve(this.approve({ toolName: 'local.workspace.apply', input: operation,
          permission: this.permissionName, risk: 'workspace-write', conversationId: this.conversationId,
          sandboxId: this.sandboxId, deviceId: this.deviceId, signal: this.controller.signal })), this.controller.signal);
      }
      if (approved !== true) return { operation_index: operationIndex, path: operation.path, status: 'failed',
        error_code: 'PERMISSION_DENIED', error_message: 'Permission approval is required for workspace changes.' };
    }
    try {
      checkAbort(this.controller.signal);
      if (operation.type === 'ensure_dir') {
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
      } else if (operation.type === 'ensure_file') {
        await this.ensureWorkspaceParentDirectory(target);
        const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600)
          .catch(async error => {
            if (error.code !== 'EEXIST') throw error;
            const stat = await fs.stat(target);
            if (!stat.isFile()) throw error;
            return null;
          });
        await handle?.close();
      } else if (operation.type === 'write_file') {
        await this.ensureWorkspaceParentDirectory(target);
        const mode = operation.mode;
        if (mode === 'keep' || mode === 'create_only') {
          const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600)
            .catch(async error => {
              if (error.code === 'EEXIST' && mode === 'keep') {
                const stat = await fs.stat(target);
                if (stat.isFile()) return null;
              }
              throw error;
            });
          await handle?.writeFile(operation.content);
          await handle?.close();
        } else {
          const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | (mode === 'append' ? fsConstants.O_APPEND : fsConstants.O_TRUNC)
            | (fsConstants.O_NOFOLLOW || 0);
          const handle = await fs.open(target, flags, 0o600);
          try { await handle.writeFile(operation.content); await handle.sync(); }
          finally { await handle.close(); }
        }
      }
      const result = { operation_index: operationIndex, path: operation.path, status: 'success' };
      if (operation.type === 'write_file' && operation.sequence !== undefined) result.sequence = operation.sequence;
      return result;
    } catch (error) {
      return { operation_index: operationIndex, path: operation.path, status: 'failed',
        error_code: error.code || 'NATIVE_API_CALL_FAILED', error_message: error.message || 'Workspace operation failed.' };
    }
  }

  async execute(call) {
    const { id, name, input, inputRaw } = call;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Local tool timed out')), this.toolTimeoutMs);
    const abort = () => controller.abort(this.controller.signal.reason || new Error('Runtime stopped'));
    this.controller.signal.addEventListener('abort', abort, { once: true });
    if (this.controller.signal.aborted) abort();
    try {
      checkAbort(controller.signal);
      const risk = await permissionRisk(this.permissionName, name, input, this.workspace);
      checkAbort(controller.signal);
      if (risk) {
        const allowed = typeof this.approve === 'function' ? await abortable(Promise.resolve(this.approve({ toolName: name, input,
          permission: this.permissionName, risk, conversationId: this.conversationId, sandboxId: this.sandboxId,
          deviceId: this.deviceId, signal: controller.signal })), controller.signal) : false;
        checkAbort(controller.signal);
        if (allowed !== true) return errorResult(id, name, 'PERMISSION_DENIED', `Permission approval is required for ${name}; the tool was not executed.`);
      }
      if (name === 'connector.call') return await this.executeConnector(call, controller.signal);
      const result = await this.executeBuiltin(call, controller.signal);
      return { ...result, id, name, ...(inputRaw ? { tool_input: inputRaw } : {}) };
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener('abort', abort);
    }
  }

  async executeConnector(call, signal) {
    const { id, name, input } = call;
    if (input.protocol_version !== 1 || typeof input.connector_id !== 'string' || !input.connector_id.trim()
      || typeof input.remote_tool_name !== 'string' || !input.remote_tool_name.trim()) {
      return errorResult(id, name, 'connector_call_invalid_input', 'Connector tool input must include protocol_version 1, connector_id, and remote_tool_name.');
    }
    if (typeof this.callConnector !== 'function') return errorResult(id, name, 'connector_shell_api_unavailable', 'Connector Shell API is unavailable; the tool was not executed.');
    try {
      const pending = this.callConnector({ connectorId: input.connector_id, toolName: input.remote_tool_name,
        arguments: input.raw_arguments ?? '', conversationId: this.conversationId, sandboxId: this.sandboxId, signal });
      const rawResult = await abortable(Promise.resolve(pending), signal);
      const mcpResult = rawResult?.mcpResponseJson ?? rawResult?.mcpResultJson ?? rawResult;
      if (mcpResult === undefined) return errorResult(id, name, 'connector_shell_api_invalid_response', 'Connector returned no result.');
      return { id, name, raw_result: typeof mcpResult === 'string' ? mcpResult : JSON.stringify(mcpResult), tool_input: call.inputRaw };
    } catch (error) {
      return errorResult(id, name, 'connector_shell_api_call_failed', `Connector invocation failed: ${error.message || error}`);
    }
  }

  async executeBuiltin(call, signal) {
    const { id, name, input } = call;
    const pathValue = input.file_path ?? input.path ?? input.notebook_path;
    const targetPath = typeof pathValue === 'string' ? path.resolve(this.workspace, pathValue) : undefined;
    switch (name) {
      case 'Bash': {
        if (typeof input.command !== 'string' || !input.command.trim()) return errorResult(id, name, 'INVALID_ARGUMENT', 'Bash requires a command string.');
        if (input.run_in_background === true) return errorResult(id, name, 'CAPABILITY_UNAVAILABLE', 'Background shell tasks are not supported by this portable runtime.');
        if (input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0)) {
          return errorResult(id, name, 'INVALID_ARGUMENT', 'Bash timeout must be a positive number of milliseconds.');
        }
        const requestedTimeout = Number(input.timeout);
        const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, this.toolTimeoutMs) : this.toolTimeoutMs;
        const result = await shell(input.command, { cwd: this.workspace,
          timeoutMs, signal, maxOutputBytes: this.maxOutputBytes });
        const text = `${result.stdout}${result.stderr ? `${result.stdout ? '\n' : ''}${result.stderr}` : ''}${result.timedOut ? '\n[command timed out]' : ''}`;
        const output = toolResult(id, name, text || `Command exited with status ${result.code}.`, { data: {
          command: input.command, exitCode: result.code, stdout: result.stdout, stderr: result.stderr,
          truncated: result.truncated, timedOut: result.timedOut, aborted: result.aborted,
        } });
        if (result.code !== 0 || result.timedOut || result.aborted) output.isError = true;
        return output;
      }
      case 'Read': {
        if (!targetPath) return errorResult(id, name, 'INVALID_ARGUMENT', 'Read requires a path.');
        const pages = input.pages;
        if (pages !== undefined && pages !== null && pages !== '' && !(Array.isArray(pages) && pages.length === 0)) {
          return errorResult(id, name, 'CAPABILITY_UNAVAILABLE', 'Portable Read supports text files only; media and PDF page extraction require the native runtime.');
        }
        const bytes = await fs.readFile(targetPath);
        const extension = path.extname(targetPath).toLowerCase();
        if (bytes.subarray(0, 5).toString('ascii') === '%PDF-' || bytes.includes(0) || MEDIA_EXTENSIONS.has(extension)) {
          return errorResult(id, name, 'CAPABILITY_UNAVAILABLE', 'Portable Read supports text files only; media and PDF extraction require the native runtime.');
        }
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return errorResult(id, name, 'CAPABILITY_UNAVAILABLE', 'Portable Read supports text files only; binary media requires the native runtime.'); }
        const offset = input.offset !== undefined && input.offset !== null
          ? Math.max(0, (Number(input.offset) || 1) - 1)
          : Math.max(0, Number(input.line_offset) || 0);
        const limit = Math.max(1, Math.min(20_000, Number(input.limit ?? input.line_limit ?? 2000) || 2000));
        const lines = content.split(/\r?\n/u);
        const body = lines.slice(offset, offset + limit).join('\n');
        return toolResult(id, name, body ? body.split('\n').map((line, index) => `${offset + index + 1}: ${line}`).join('\n') : '',
          { data: { path: targetPath, content: body, lineCount: lines.length, lineOffset: offset, truncated: offset + limit < lines.length } });
      }
      case 'Write': {
        if (!targetPath || typeof input.content !== 'string') return errorResult(id, name, 'INVALID_ARGUMENT', 'Write requires path and content.');
        const existed = await fs.stat(targetPath).then(stat => stat.isFile()).catch(() => false);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, input.content, 'utf8');
        return toolResult(id, name, `Wrote ${targetPath}.`, { data: { filePath: targetPath, created: !existed, bytesWritten: Buffer.byteLength(input.content) } });
      }
      case 'Edit': {
        if (!targetPath || typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string') return errorResult(id, name, 'INVALID_ARGUMENT', 'Edit requires file_path, non-empty old_string, and new_string.');
        const source = await readText(targetPath);
        const count = source.split(input.old_string).length - 1;
        if (count < 1) return errorResult(id, name, 'INVALID_ARGUMENT', 'Edit target text was not found.', { data: { replacements: 0 } });
        if (count > 1 && input.replace_all !== true) return errorResult(id, name, 'INVALID_ARGUMENT', 'Edit target text is not unique; set replace_all to replace every occurrence.', { data: { replacements: 0, matchCount: count } });
        const next = input.replace_all === true ? source.split(input.old_string).join(input.new_string)
          : source.replace(input.old_string, input.new_string);
        await fs.writeFile(targetPath, next, 'utf8');
        return toolResult(id, name, `Edited ${targetPath}.`, { data: { filePath: targetPath, replacements: input.replace_all === true ? count : 1 } });
      }
      case 'NotebookEdit': return this.editNotebook(call, targetPath);
      case 'Glob': return this.glob(call, signal);
      case 'Grep': return this.grep(call, signal);
      default: return errorResult(id, name, 'UNKNOWN_TOOL', `Unsupported local tool "${name}"; it was not executed.`);
    }
  }

  async editNotebook(call, targetPath) {
    const { id, name, input } = call;
    const file = targetPath;
    const mode = input.edit_mode || 'replace';
    if (!file || !['replace', 'insert', 'delete'].includes(mode)) return errorResult(id, name, 'INVALID_ARGUMENT', 'NotebookEdit requires notebook_path and a supported edit_mode.');
    if (mode !== 'insert' && typeof input.cell_id !== 'string') return errorResult(id, name, 'INVALID_ARGUMENT', 'NotebookEdit requires cell_id.');
    if (mode === 'insert' && !['code', 'markdown'].includes(input.cell_type)) return errorResult(id, name, 'INVALID_ARGUMENT', 'cell_type must be code or markdown.');
    if (mode !== 'delete' && typeof input.new_source !== 'string') return errorResult(id, name, 'INVALID_ARGUMENT', 'NotebookEdit requires new_source.');
    const sourceLines = source => source.match(/[^\n]*\n|[^\n]+$/gu) || [];
    const notebook = JSON.parse(await readText(file));
    if (!Array.isArray(notebook.cells)) return errorResult(id, name, 'INVALID_ARGUMENT', 'Notebook does not contain a cells array.');
    const cellIndex = notebook.cells.findIndex(cell => cell.id === input.cell_id);
    if (mode === 'insert') notebook.cells.push({ cell_type: input.cell_type, metadata: {}, source: sourceLines(input.new_source),
      ...(input.cell_type === 'code' ? { execution_count: null, outputs: [] } : {}), id: randomUUID() });
    else if (cellIndex < 0) return errorResult(id, name, 'INVALID_ARGUMENT', `Notebook cell "${input.cell_id}" was not found.`);
    else if (mode === 'delete') notebook.cells.splice(cellIndex, 1);
    else notebook.cells[cellIndex].source = sourceLines(input.new_source);
    await fs.writeFile(file, `${JSON.stringify(notebook, null, 2)}\n`, 'utf8');
    return toolResult(id, name, `Notebook ${mode} succeeded for ${file}.`, { data: { notebookPath: file, editMode: mode, cellId: input.cell_id } });
  }

  async glob(call, signal) {
    const { id, name, input } = call;
    if (typeof input.pattern !== 'string' || !input.pattern) return errorResult(id, name, 'INVALID_ARGUMENT', 'Glob requires a pattern.');
    const root = input.path ? path.resolve(this.workspace, input.path) : this.workspace;
    const { results, truncated } = await walkFiles(root, input, signal);
    const regex = globRegex(input.pattern.replaceAll('\\', '/'));
    const matches = results.filter(item => regex.test(path.relative(this.workspace, path.resolve(root, item)).replaceAll('\\', '/')) || regex.test(item.replaceAll('\\', '/')));
    return toolResult(id, name, matches.join('\n'), { data: { matches, count: matches.length, truncated } });
  }

  async grep(call, signal) {
    const { id, name, input } = call;
    if (typeof input.pattern !== 'string' || !input.pattern) return errorResult(id, name, 'INVALID_ARGUMENT', 'Grep requires a pattern.');
    const root = input.path ? path.resolve(this.workspace, input.path) : this.workspace;
    const { results } = await walkFiles(root, { maxResults: 5000 }, signal);
    const multiline = input.multiline === true;
    let regex;
    try { regex = new RegExp(input.pattern, `${input['-i'] || input.case_insensitive ? 'i' : ''}${multiline ? 'ms' : ''}${multiline ? 'g' : ''}u`); }
    catch (error) { return errorResult(id, name, 'INVALID_ARGUMENT', `Invalid grep pattern: ${error.message}`); }
    const glob = input.glob || input.include;
    const globFilter = typeof glob === 'string' ? globRegex(glob.replaceAll('\\', '/')) : null;
    const matches = [];
    for (const relative of results) {
      checkAbort(signal);
      if (globFilter && !globFilter.test(relative)) continue;
      if (typeof input.type === 'string' && input.type) {
        const typeExtensions = { javascript: ['.js', '.jsx', '.mjs', '.cjs'], typescript: ['.ts', '.tsx'], python: ['.py'], rust: ['.rs'], go: ['.go'], ruby: ['.rb'], java: ['.java'], json: ['.json'], markdown: ['.md', '.markdown'] };
        const extensions = typeExtensions[input.type.toLowerCase()] || ( /^[a-z0-9]+$/iu.test(input.type) ? [`.${input.type.toLowerCase()}`] : null );
        if (!extensions) return errorResult(id, name, 'INVALID_ARGUMENT', `Unsupported Grep file type "${input.type}".`);
        if (!extensions.includes(path.extname(relative).toLowerCase())) continue;
      }
      let text;
      try { text = await readText(path.join(root, relative)); } catch { continue; }
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/u);
      if (multiline) {
        for (const matched of text.matchAll(regex)) {
          const prefix = text.slice(0, matched.index);
          const line = prefix.split(/\r?\n/u).length;
          matches.push({ path: relative, line, text: matched[0] });
          if (matches.length >= 5000) break;
        }
      } else {
        for (let index = 0; index < lines.length; index += 1) {
          if (regex.test(lines[index])) matches.push({ path: relative, line: index + 1, text: lines[index] });
          if (matches.length >= 5000) break;
        }
      }
      if (matches.length >= 5000) break;
    }
    const mode = input.output_mode || 'files_with_matches';
    if (!['count', 'content', 'files_with_matches'].includes(mode)) return errorResult(id, name, 'INVALID_ARGUMENT', `Unsupported Grep output_mode "${mode}".`);
    const offset = Math.max(0, Number(input.offset) || 0);
    const headLimit = Math.max(1, Number(input.head_limit) || 250);
    const uniqueFiles = [...new Set(matches.map(match => match.path))];
    const selected = matches.slice(offset, offset + headLimit);
    const selectedFiles = uniqueFiles.slice(offset, offset + headLimit);
    const lineNumbers = input['-n'] !== false;
    let output;
    if (mode === 'count') output = [...new Set(matches.map(match => match.path))].map(file => `${file}:${matches.filter(match => match.path === file).length}`);
    else if (mode === 'files_with_matches') output = selectedFiles;
    else {
      const context = Math.max(0, Number(input['-C'] ?? input.context ?? 0) || 0);
      const before = Math.max(0, Number(input['-B'] ?? context) || 0);
      const after = Math.max(0, Number(input['-A'] ?? context) || 0);
      const blocks = [];
      for (const match of selected) {
        let matchText = match.text;
        if (before || after) {
          const fileLines = (await readText(path.join(root, match.path))).split(/\r?\n/u);
          matchText = fileLines.slice(Math.max(0, match.line - before - 1), Math.min(fileLines.length, match.line + after)).map((line, index) => {
            const lineNumber = Math.max(0, match.line - before - 1) + index + 1;
            return `${match.path}${lineNumbers ? `:${lineNumber}` : ''}:${line}`;
          }).join('\n');
        } else matchText = `${match.path}${lineNumbers ? `:${match.line}` : ''}:${matchText}`;
        blocks.push(matchText);
      }
      output = blocks;
    }
    const content = output.join('\n');
    return toolResult(id, name, content, { data: { content, matches, count: matches.length, truncated: (mode === 'files_with_matches' ? selectedFiles.length : selected.length) < (mode === 'files_with_matches' ? uniqueFiles.length : matches.length) } });
  }
}
