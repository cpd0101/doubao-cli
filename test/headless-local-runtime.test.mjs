import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HeadlessLocalRuntime, buildHeadlessLocalTaskParam, prepareHeadlessLocalChannel,
  isAgentSessionScaffoldPath, workspaceApplyRequiresApproval } from '../src/headless-local-runtime.mjs';

const conversationId = '1234567890123456';
const base = (overrides = {}) => ({
  sandboxId: 'sandbox-test-1', deviceId: '123456', conversationId,
  workspace: process.cwd(), permission: 'FullAccess', accountId: '123456', ...overrides,
});

function responseStream() {
  return new Response(new ReadableStream({ start() {}, cancel() {} }), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

function toolFrame({ sandboxId = 'sandbox-test-1', conversation, id = 'call-1', name = 'Read', input = { file_path: 'package.json' } } = {}) {
  const option = { agent_id: 'agent-fixture', generate_timestamp_ms: 1_800_000_000_000 };
  if (conversation) option.conversation_id = conversation;
  return { event_type: 1, sandbox_id: sandboxId, seq: 7,
    signature: { device_id: '123456', key_id: 'fixture-key', signature: 'fixture-signature', timestamp_ms: 1_800_000_000_000, user_id: '123456' },
    tool_call: { id, name, input: JSON.stringify(input), option } };
}

test('builds the local runtime general_task_param with runtime 2 and permission enum', () => {
  const built = buildHeadlessLocalTaskParam({ workspace: '/tmp/work', sandboxId: 'route-123', deviceId: '123456', permission: 'AskOnRisk', homeDir: '/tmp/home' });
  assert.equal(built.sandboxAuthType, 1);
  assert.equal(built.sandboxId, 'route-123');
  const parsed = JSON.parse(built.general_task_param);
  assert.equal(parsed.runtime_type, 2);
  assert.equal(parsed.agent_task_param.runtime_type, 2);
  assert.equal(parsed.client_option.os, process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : 'Linux');
  assert.equal(parsed.client_option.sandbox_id, 'route-123');
  assert.equal(parsed.client_option.workspace, '/tmp/work');
  assert.deepEqual(parsed.client_option.shared_folder_path, ['/tmp/work']);
  assert.equal(JSON.parse(parsed.task_input_json).home_dir, '/tmp/home');
});

test('accepts signed 64-bit device ids and rejects out-of-range values', () => {
  const maxDeviceId = '9223372036854775807';
  const built = buildHeadlessLocalTaskParam({ workspace: '/tmp/work', deviceId: maxDeviceId });
  assert.equal(JSON.parse(built.general_task_param).agent_task_param.local_device_id, maxDeviceId);
  assert.throws(() => buildHeadlessLocalTaskParam({ workspace: '/tmp/work', deviceId: '9223372036854775808' }),
    /signed 64-bit range/u);
  assert.throws(() => new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base({ deviceId: '9223372036854775808' }) }), /signed 64-bit range/u);
});

test('accepts readiness only after SSE and sends route scope and resume header', async () => {
  const requests = [];
  const client = {
    async request(route, options) { requests.push({ route, options }); return responseStream(); },
    async json() { return { status_code: 0 }; },
  };
  const runtime = new HeadlessLocalRuntime({ client, ...base() });
  const ready = await runtime.start();
  assert.equal(ready.ready, true);
  assert.equal(ready.transport, 'http-sse');
  assert.equal(requests[0].route, '/alice/office/tool_local/chunk_stream');
  assert.deepEqual(requests[0].options.params, { sand_box_id: 'sandbox-test-1', client_version: 'unspecified' });
  assert.deepEqual(JSON.parse(requests[0].options.body), { device_id: '123456', client_attrs: { sandbox_id: 'sandbox-test-1' } });
  assert.equal(requests[0].options.signal, runtime.controller.signal);
  runtime.lastEventId = 'event-42';
  await runtime.close();
});

test('prepares the sandbox-scoped SSE request before completion and consumes that response first', async () => {
  const requests = [];
  let cancelled = 0;
  const client = { request: async (route, options) => {
    requests.push({ route, options });
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled += 1; } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  }, json: async () => ({ code: 0 }) };
  const initialResponse = await prepareHeadlessLocalChannel(client, { sandboxId: 'sandbox-test-1', deviceId: '123456' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, '/alice/office/tool_local/chunk_stream');
  assert.deepEqual(requests[0].options.params, { sand_box_id: 'sandbox-test-1', client_version: 'unspecified' });
  assert.deepEqual(JSON.parse(requests[0].options.body), { device_id: '123456', client_attrs: { sandbox_id: 'sandbox-test-1' } });
  assert.equal(requests[0].options.headers['Agw-Js-Conv'], 'str');

  const runtime = new HeadlessLocalRuntime({ client, ...base(), initialResponse });
  const ready = await runtime.start();
  assert.equal(ready.ready, true);
  assert.equal(requests.length, 1, 'start must consume the preconnected response without issuing a duplicate request');
  await runtime.close();
  assert.equal(cancelled, 1);
});

test('reconnects only after the preconnected response ends', async () => {
  let requests = 0;
  const client = { request: async () => {
    requests += 1;
    return requests === 1
      ? new Response('id: evt-warm\ndata: {"event_type":3}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : responseStream();
  }, json: async () => ({}) };
  const initialResponse = await prepareHeadlessLocalChannel(client, { sandboxId: 'sandbox-test-1', deviceId: '123456' });
  const runtime = new HeadlessLocalRuntime({ client, ...base(), initialResponse });
  await runtime.start();
  const deadline = Date.now() + 2_000;
  while (requests < 2 && Date.now() < deadline) await sleep(10);
  assert.equal(requests, 2, 'a reconnect is expected only after the warm stream closes');
  await runtime.close();
});

test('cancels a prepared channel on invalid response, idle close, or lease conflict', async () => {
  let invalidCancelled = 0;
  await assert.rejects(prepareHeadlessLocalChannel({ request: async () => new Response(
    new ReadableStream({ start() {}, cancel() { invalidCancelled += 1; } }), { status: 400, headers: { 'content-type': 'text/plain' } },
  ) }, { sandboxId: 'sandbox-test-1', deviceId: '123456' }), /SSE connection failed \(400\)/u);
  assert.equal(invalidCancelled, 1);

  let idleCancelled = 0;
  const idle = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base(), initialResponse: new Response(new ReadableStream({ start() {}, cancel() { idleCancelled += 1; } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }) });
  await idle.close();
  assert.equal(idleCancelled, 1);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-warm-lease-'));
  const journalPath = path.join(await fs.realpath(directory), 'journal.json');
  const options = { ...base({ workspace: directory }), journalPath, accountId: '123456' };
  const owner = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) }, ...options });
  await owner.start();
  let busyCancelled = 0;
  const contender = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) }, ...options,
    initialResponse: new Response(new ReadableStream({ start() {}, cancel() { busyCancelled += 1; } }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }) });
  await assert.rejects(contender.start(), error => error.code === 'LOCAL_RUNTIME_BUSY');
  assert.equal(busyCancelled, 1);
  await owner.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('resumes an interrupted SSE stream with its last event id', async () => {
  const requests = [];
  const client = {
    async request(route, options) {
      requests.push({ route, options });
      return requests.length === 1
        ? new Response('id: evt-1\ndata: {"event_type":3}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : responseStream();
    },
    async json() { return {}; },
  };
  const runtime = new HeadlessLocalRuntime({ client, ...base() });
  await runtime.start();
  const deadline = Date.now() + 2_000;
  while (requests.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests.length >= 2, true);
  assert.equal(requests[1].options.headers['last-event-id'], 'evt-1');
  await runtime.close();
});

test('consumes a late request rejection when the signal aborts before the pending request settles', async () => {
  let runtime;
  let rejectRequest;
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  runtime = new HeadlessLocalRuntime({ client: { request: async () => {
    runtime.controller.abort(new Error('fixture abort'));
    return new Promise((_resolve, reject) => {
      rejectRequest = reject;
      setTimeout(() => rejectRequest(new Error('late fetch rejection')), 5);
    });
  }, json: async () => ({}) }, ...base() });
  try {
    await assert.rejects(runtime.start(), /fixture abort/u);
    await sleep(30);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await runtime.close();
  }
});

test('permanent SSE 400 rejects once and close releases the runtime lease', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-http-400-'));
  const journalPath = path.join(await fs.realpath(directory), 'journal.json');
  let requests = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => {
    requests += 1;
    return new Response('invalid device id', { status: 400 });
  }, json: async () => ({}) }, ...base({ workspace: directory }), journalPath, accountId: '123456' });
  await assert.rejects(runtime.start(), /SSE connection failed \(400\)/u);
  assert.equal(requests, 1);
  await runtime.close();
  await assert.rejects(fs.access(`${journalPath}.lock`), { code: 'ENOENT' });
  await fs.rm(directory, { recursive: true, force: true });
});

test('login_required SSE failure rejects immediately while a 503 reconnects', async () => {
  let loginRequests = 0;
  const loginError = Object.assign(new Error('login required'), { code: 'login_required' });
  const loginRuntime = new HeadlessLocalRuntime({ client: { request: async () => { loginRequests += 1; throw loginError; },
    json: async () => ({}) }, ...base() });
  await assert.rejects(loginRuntime.start(), /login required/u);
  assert.equal(loginRequests, 1);
  await loginRuntime.close();

  let transientRequests = 0;
  let reported = 0;
  const transientRuntime = new HeadlessLocalRuntime({ client: { request: async () => {
    transientRequests += 1;
    return transientRequests === 1 ? new Response('temporary', { status: 503 }) : responseStream();
  }, json: async () => ({}) }, ...base({ onError: () => { reported += 1; } }) });
  const ready = await transientRuntime.start();
  assert.equal(ready.ready, true);
  assert.equal(transientRequests, 2);
  assert.equal(reported, 1);
  await transientRuntime.close();
});

test('routes native tool_call events by owned sandbox and rejects explicit conversation mismatches', async () => {
  let uploads = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => { uploads += 1; return {}; } }, ...base() });
  await runtime.handleFrame(toolFrame({ sandboxId: 'other-sandbox', name: 'Bash', input: { command: 'touch SHOULD_NOT_EXIST' } }));
  await runtime.handleFrame(toolFrame({ conversation: '9876543210987654', name: 'Bash', input: { command: 'touch SHOULD_NOT_EXIST' } }));
  assert.equal(uploads, 0);
  assert.equal(runtime.records.size, 0);
});

test('acknowledges native sandbox commands bound by owned sandbox when conversation is omitted', async () => {
  let uploads = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => { uploads += 1; return {}; } }, ...base() });
  const command = { id: 'command-1', name: 'local.workspace.apply', input: '{}', need_ack: true,
    option: { agent_id: 'agent-fixture' } };
  const signature = { device_id: '123456', key_id: 'fixture-key', signature: 'fixture-signature', timestamp_ms: 1_800_000_000_000, user_id: '123456' };
  await runtime.handleFrame({ event_type: 2, sandbox_id: 'sandbox-test-1', signature, command });
  await runtime.handleFrame({ event_type: 2, sandbox_id: 'sandbox-test-1', signature, command: {
    ...command, option: { ...command.option, conversation_id: '9876543210987654' },
  } });
  assert.equal(uploads, 1);
});

test('drops signed tool events whose provided account or device identity does not match the runtime', async () => {
  let executions = 0;
  let uploads = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => { uploads += 1; return {}; } }, ...base() });
  runtime.execute = async call => {
    executions += 1;
    return { id: call.id, name: call.name, content: [{ type: 'text', text: 'fixture' }], isError: false };
  };
  const valid = toolFrame();
  await runtime.handleFrame(valid);
  await runtime.handleFrame({ ...toolFrame({ id: 'wrong-device' }), signature: { ...valid.signature, device_id: '999999' } });
  await runtime.handleFrame({ ...toolFrame({ id: 'wrong-user' }), signature: { ...valid.signature, user_id: '999999' } });
  await runtime.handleFrame({ ...toolFrame({ id: 'malformed-signature' }), signature: 'not-an-envelope' });
  assert.equal(executions, 1);
  assert.equal(uploads, 1);
});

test('does not rerun a tool after result upload failure; duplicate delivery only retries upload', async () => {
  let executions = 0;
  let uploads = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (_route, options) => {
    uploads += 1;
    if (uploads === 1) return { code: 204001 };
    return { status_code: 0 };
  } }, ...base() });
  runtime.execute = async call => { executions += 1; return { id: call.id, name: call.name, content: [{ type: 'text', text: 'done' }], isError: false }; };
  const frame = toolFrame();
  await assert.rejects(runtime.handleFrame(frame), /rejected \(204001\)/u);
  await runtime.handleFrame(frame);
  assert.equal(executions, 1);
  assert.equal(uploads, 2);
  assert.equal(runtime.records.get('call-1').status, 'uploaded');
});

test('journal is account/runtime scoped, mode 0600, and refuses to rerun an interrupted side effect', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-journal-'));
  const journalPath = path.join(await fs.realpath(directory), 'state.json');
  const scope = { ...base({ workspace: directory }), journalPath, accountId: '123456' };
  let releaseExecution;
  const first = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({ code: 0 }) }, ...scope });
  first.execute = () => new Promise(resolve => { releaseExecution = resolve; });
  const frame = toolFrame({ name: 'Write', input: { file_path: 'note.txt', content: 'once' } });
  const interruptedExecution = first.handleFrame(frame);
  const deadline = Date.now() + 2_000;
  let journal;
  while (Date.now() < deadline) {
    try { journal = JSON.parse(await fs.readFile(journalPath, 'utf8')); break; } catch { await sleep(10); }
  }
  assert.equal(journal?.records?.[0]?.status, 'started');
  assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);

  let executions = 0;
  let uploaded;
  const recovered = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (_route, options) => {
    uploaded = JSON.parse(options.body).tool_result;
    return { code: 0 };
  } }, ...scope });
  recovered.execute = async () => { executions += 1; throw new Error('must not rerun'); };
  await recovered.handleFrame(frame);
  assert.equal(executions, 0);
  assert.equal(uploaded.error_code, 'TOOL_OUTCOME_UNCONFIRMED');

  const wrongAccount = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...scope, accountId: '654321' });
  await assert.rejects(wrongAccount.start(), /different account or runtime scope/u);
  releaseExecution?.({ id: 'call-1', name: 'Write', isError: false, content: [{ type: 'text', text: 'done' }] });
  await interruptedExecution;
  await fs.rm(directory, { recursive: true, force: true });
});

test('journal lease permits one live runtime and releases only its own lock', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-lease-'));
  const journalPath = path.join(await fs.realpath(directory), 'journal.json');
  const options = { ...base({ workspace: directory }), journalPath, accountId: '123456' };
  const client = { request: async () => responseStream(), json: async () => ({ code: 0 }) };
  const owner = new HeadlessLocalRuntime({ client, ...options });
  await owner.start();
  const lockPath = `${journalPath}.lock`;
  assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o700);
  const lockOwner = path.join(lockPath, (await fs.readdir(lockPath))[0]);
  assert.equal((await fs.stat(lockOwner)).mode & 0o777, 0o600);

  const contender = new HeadlessLocalRuntime({ client, ...options });
  await assert.rejects(contender.start(), error => error.code === 'LOCAL_RUNTIME_BUSY');
  await owner.close();
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });

  await contender.start();
  await contender.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('journal lease removes only a stale owner from the same scope', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-stale-lease-'));
  const journalPath = path.join(await fs.realpath(directory), 'journal.json');
  let stalePid = 2_000_000_000;
  while (true) {
    try { process.kill(stalePid, 0); stalePid += 1; }
    catch (error) { if (error.code === 'ESRCH') break; stalePid += 1; }
  }
  const lockPath = `${journalPath}.lock`;
  await fs.mkdir(lockPath, { mode: 0o700 });
  await fs.writeFile(path.join(lockPath, 'owner-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'), `${JSON.stringify({ version: 1, accountId: '123456', sandboxId: 'sandbox-test-1',
    deviceId: '123456', conversationId, pid: stalePid, token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })}\n`, { mode: 0o600 });
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base({ workspace: directory }), journalPath, accountId: '123456' });
  await runtime.start();
  const [ownerName] = await fs.readdir(lockPath);
  const lease = JSON.parse(await fs.readFile(path.join(lockPath, ownerName), 'utf8'));
  assert.equal(lease.pid, process.pid);
  assert.notEqual(lease.token, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await runtime.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('concurrent stale lease recovery admits exactly one owner', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-stale-race-'));
  const journalPath = path.join(await fs.realpath(directory), 'journal.json');
  let stalePid = 2_000_000_000;
  while (true) {
    try { process.kill(stalePid, 0); stalePid += 1; }
    catch (error) { if (error.code === 'ESRCH') break; stalePid += 1; }
  }
  const lockPath = `${journalPath}.lock`;
  const staleToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await fs.mkdir(lockPath, { mode: 0o700 });
  const ownerPath = path.join(lockPath, `owner-${staleToken}.json`);
  await fs.writeFile(ownerPath, `${JSON.stringify({ version: 1, accountId: '123456', sandboxId: 'sandbox-test-1',
    deviceId: '123456', conversationId, pid: stalePid, token: staleToken })}\n`, { mode: 0o600 });

  const client = { request: async () => responseStream(), json: async () => ({ code: 0 }) };
  const options = { ...base({ workspace: directory }), journalPath, accountId: '123456', client };
  const first = new HeadlessLocalRuntime(options);
  const second = new HeadlessLocalRuntime(options);
  const originalUnlink = fs.unlink;
  let arrivals = 0;
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });
  fs.unlink = async target => {
    if (path.resolve(String(target)) === ownerPath) {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    }
    return originalUnlink(target);
  };
  try {
    const outcomes = await Promise.allSettled([first.start(), second.start()]);
    assert.equal(arrivals, 2, 'both contenders should reach stale-owner removal before either proceeds');
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected' && item.reason?.code === 'LOCAL_RUNTIME_BUSY').length, 1);
    const winner = outcomes[0].status === 'fulfilled' ? first : second;
    const [name] = await fs.readdir(lockPath);
    const current = JSON.parse(await fs.readFile(path.join(lockPath, name), 'utf8'));
    assert.equal(current.pid, process.pid);
    await winner.close();
  } finally {
    fs.unlink = originalUnlink;
    await first.close();
    await second.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('AskOnRisk checks Read file_path against symlinks that escape the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-path-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.symlink(outside, path.join(workspace, 'outside-link'));
  let readCalls = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base({ workspace, permission: 'AskOnRisk', approve: async () => false }) });
  runtime.executeBuiltin = async () => { readCalls += 1; return {}; };
  const result = await runtime.execute({ id: 'read-1', name: 'Read', input: { file_path: 'outside-link/private.txt' }, inputRaw: '' });
  assert.equal(result.error_code, 'PERMISSION_DENIED');
  assert.equal(readCalls, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('closing during an approval callback prevents a subsequently granted tool from executing', async () => {
  let finishApproval;
  let executeCalls = 0;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base({ permission: 'AskOnRisk', approve: () => new Promise(resolve => { finishApproval = resolve; }) }) });
  runtime.executeBuiltin = async () => { executeCalls += 1; return {}; };
  const work = runtime.execute({ id: 'pending-approval', name: 'Bash', input: { command: 'touch unsafe' }, inputRaw: '' });
  while (!finishApproval) await sleep(1);
  await runtime.close();
  finishApproval(true);
  await assert.rejects(work, /Stopped/u);
  assert.equal(executeCalls, 0);
});

test('Read uses the packaged file_path schema and returns structured text data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-read-'));
  await fs.writeFile(path.join(directory, 'sample.txt'), 'alpha\nbeta\n');
  try {
    const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) }, ...base({ workspace: directory }) });
    const first = await runtime.execute({ id: 'read-first-line', name: 'Read', input: { file_path: 'sample.txt', offset: 1, limit: 1 }, inputRaw: '' });
    assert.equal(first.data.content, 'alpha');
    assert.equal(first.data.lineOffset, 0);
    const result = await runtime.execute({ id: 'read-schema', name: 'Read', input: { file_path: 'sample.txt', offset: 2, limit: 1 }, inputRaw: '' });
    assert.equal(result.isError, false);
    assert.equal(result.data.content, 'beta');
    assert.equal(result.data.lineCount, 3);
    assert.equal(result.data.lineOffset, 1);
    const legacy = await runtime.execute({ id: 'read-legacy-offset', name: 'Read', input: { file_path: 'sample.txt', line_offset: 1, limit: 1 }, inputRaw: '' });
    assert.equal(legacy.data.content, 'beta');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native Read accepts thumbnail defaults for text and refuses PDF content', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-read-native-'));
  await fs.writeFile(path.join(directory, 'probe.txt'), 'plain text probe\n');
  await fs.writeFile(path.join(directory, 'probe.pdf'), '%PDF-1.7\n% fixture PDF body');
  const uploads = [];
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (_route, options) => {
    uploads.push(JSON.parse(options.body).tool_result);
    return { status_code: 0 };
  } }, ...base({ workspace: directory, permission: 'AskOnRisk', approve: async () => false }) });
  try {
    await runtime.handleFrame(toolFrame({ id: 'read-text-probe', input: {
      file_path: 'probe.txt', offset: 1, limit: 2000, thumbnail_size: 'full', pages: '',
    } }));
    await runtime.handleFrame(toolFrame({ id: 'read-pdf-probe', input: {
      file_path: 'probe.pdf', thumbnail_size: 'full', pages: null,
    } }));

    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].isError, false);
    assert.equal(uploads[0].data.content, 'plain text probe\n');
    assert.equal(uploads[0].data.lineOffset, 0);
    assert.equal(uploads[1].error_code, 'CAPABILITY_UNAVAILABLE');
    assert.match(uploads[1].content[0].text, /PDF extraction require the native runtime/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('approval denial never executes shell command; approved FullAccess shell uses fixture workspace', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-'));
  try {
    let approvedExecutions = 0;
    const denied = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
      ...base({ workspace: directory, permission: 'AskOnRisk', approve: async () => false }) });
    denied.executeBuiltin = async () => { approvedExecutions += 1; return {}; };
    const deniedResult = await denied.execute({ id: 'c1', name: 'Bash', input: { command: 'true' }, inputRaw: '' });
    assert.equal(deniedResult.error_code, 'PERMISSION_DENIED');
    assert.equal(approvedExecutions, 0);

    const allowed = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) }, ...base({ workspace: directory }) });
    const result = await allowed.execute({ id: 'c2', name: 'Bash', input: { command: 'printf fixture > runtime-output.txt' }, inputRaw: '' });
    assert.equal(result.isError, false);
    assert.equal(await fs.readFile(path.join(directory, 'runtime-output.txt'), 'utf8'), 'fixture');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('shell abort kills its process group and descendants within a bounded time', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-runtime-shell-'));
  try {
    const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
      ...base({ workspace: directory, toolTimeoutMs: 10_000 }) });
    const execution = runtime.execute({ id: 'timeout', name: 'Bash', input: {
      command: 'sleep 30 & echo $! > child.pid; wait', timeout: 30_000,
    }, inputRaw: '' });
    const pidPath = path.join(directory, 'child.pid');
    const readyDeadline = Date.now() + 3_000;
    while (Date.now() < readyDeadline) {
      if (await fs.stat(pidPath).then(() => true).catch(() => false)) break;
      await sleep(10);
    }
    assert.equal(await fs.stat(pidPath).then(() => true).catch(() => false), true, 'descendant should be running before abort');
    const childPid = Number(await fs.readFile(pidPath, 'utf8'));
    const stopAt = Date.now();
    runtime.controller.abort(new Error('fixture stop'));
    const result = await Promise.race([execution, sleep(2_000).then(() => { throw new Error('shell shutdown exceeded 2 seconds'); })]);
    assert.equal(result.isError, true);
    assert.equal(result.data.aborted, true);
    assert.ok(Date.now() - stopAt < 2_000);
    let alive = true;
    const exitDeadline = Date.now() + 3_000;
    while (alive && Date.now() < exitDeadline) {
      alive = await new Promise(resolve => {
        import('node:child_process').then(({ spawn }) => {
          const check = spawn('kill', ['-0', String(childPid)], { stdio: 'ignore' });
          check.once('close', code => resolve(code === 0));
          check.once('error', () => resolve(false));
        });
      });
      if (alive) await sleep(25);
    }
    assert.equal(alive, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('unknown tools return explicit errors and connector.call delegates with scoped context', async () => {
  let connectorArgs;
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base({ callConnector: async args => { connectorArgs = args; return { ok: true }; } }) });
  const unknown = await runtime.execute({ id: 'u1', name: 'native.unknown', input: {}, inputRaw: '' });
  assert.equal(unknown.error_code, 'UNKNOWN_TOOL');
  const connector = await runtime.execute({ id: 'u2', name: 'connector.call', input: {
    protocol_version: 1, connector_id: 'conn-1', remote_tool_name: 'lookup', raw_arguments: '{"q":"x"}',
  }, inputRaw: '{"protocol_version":1}' });
  assert.equal(connector.raw_result, '{"ok":true}');
  assert.equal(connector.tool_input, '{"protocol_version":1}');
  assert.deepEqual({ connectorId: connectorArgs.connectorId, toolName: connectorArgs.toolName,
    conversationId: connectorArgs.conversationId, sandboxId: connectorArgs.sandboxId }, {
    connectorId: 'conn-1', toolName: 'lookup', conversationId, sandboxId: 'sandbox-test-1',
  });
});

test('connector upload serializes an MCP result object into the native raw_result DTO string', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'headless-runtime-mcp-wire-'));
  const journalPath = path.join(directory, 'journal.json');
  const response = { content: [{ type: 'text', text: 'expectedmarker' }], isError: false };
  const uploads = [];
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (_route, options) => {
    uploads.push(JSON.parse(options.body).tool_result);
    return uploads.length === 1 ? { code: 400001 } : { code: 0 };
  } }, ...base({ workspace: directory, callConnector: async () => ({ mcpResponseJson: response }) }), journalPath });
  const frame = toolFrame({ name: 'connector.call', input: { protocol_version: 1, connector_id: 'conn-123456',
    remote_tool_name: 'lookup', raw_arguments: '{}' } });
  await assert.rejects(runtime.handleFrame(frame), /rejected \(400001\)/u);
  // Older journals kept the MCP DTO as an object. A retry must serialize it at the wire boundary.
  runtime.records.get(frame.tool_call.id).result.raw_result = response;
  await runtime.handleFrame(frame);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].raw_result, JSON.stringify(response));
  assert.equal(uploads[1].raw_result, JSON.stringify(response));
  assert.equal(uploads[0].content, undefined);
  assert.equal(uploads[0].isError, undefined);
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(journal.records[0].result.raw_result, JSON.stringify(response));
  await fs.rm(directory, { recursive: true, force: true });
});

test('applies native local.workspace.apply operations inside the owned workspace and deduplicates by command id', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'headless-runtime-workspace-'));
  const uploads = [];
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (route, options) => {
    uploads.push({ route, body: JSON.parse(options.body) });
    return { status_code: 0 };
  } }, ...base({ workspace: directory }) });
  const request = { request_id: 'req-1', workspace: { root: directory, session_id: 'session-1', agent_id: 'agent-fixture' },
    operations: [
      { type: 'ensure_dir', path: 'notes' },
      { type: 'write_file', path: 'notes/agents.md', mode: 'replace', content: 'owned workspace only', sequence: 2 },
    ] };
  const frame = { event_type: 2, sandbox_id: 'sandbox-test-1',
    signature: { device_id: '123456', user_id: '123456' },
    command: { id: 'command-apply-1', name: 'local.workspace.apply', input: JSON.stringify(request), need_ack: true,
      option: { agent_id: 'agent-fixture' } } };
  await runtime.handleFrame(frame);
  await runtime.handleFrame(frame);
  assert.equal(await fs.readFile(path.join(directory, 'notes/agents.md'), 'utf8'), 'owned workspace only');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].route, '/alice/office/tool_local/upload_command_result');
  assert.deepEqual(uploads[0].body.workspace_apply_response.operation_results.map(row => row.status), ['success', 'success']);
  assert.equal(uploads[0].body.command_result.code, 0);
  await fs.rm(directory, { recursive: true, force: true });
});

test('workspace apply creates missing parents when append/write arrives before init_agent_workspace', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'headless-runtime-workspace-order-'));
  const uploads = [];
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (route, options) => {
    uploads.push({ route, body: JSON.parse(options.body) });
    return { status_code: 0 };
  } }, ...base({ workspace: directory }) });
  const conversation = '38451201775587074';
  const agent = 'm_0cw3SnGHm1o';
  const trajectory = `.sessions/${conversation}/agents/${agent}/system/trajectory.jsonl`;
  const append = { request_id: 'append_workspace_trajectory_memory_fixture',
    workspace: { root: directory, session_id: conversation, agent_id: agent },
    operations: [{ type: 'write_file', path: trajectory, mode: 'append', content: '{"event":"start"}\n' }] };
  const init = { request_id: 'init_agent_workspace_fixture',
    workspace: { root: directory, session_id: conversation, agent_id: agent },
    operations: [
      { type: 'ensure_dir', path: `.sessions/${conversation}/memory` },
      { type: 'ensure_file', path: `.sessions/${conversation}/memory/MEMORY.md` },
      { type: 'ensure_dir', path: `.sessions/${conversation}/attachments` },
      { type: 'ensure_file', path: `.sessions/${conversation}/board.md` },
      { type: 'ensure_dir', path: `.sessions/${conversation}/agents/${agent}/scratch` },
      { type: 'ensure_dir', path: `.sessions/${conversation}/agents/${agent}/system/tool-results` },
      { type: 'ensure_file', path: `.sessions/${conversation}/agents/${agent}/system/assignment.md` },
      { type: 'ensure_file', path: trajectory },
      { type: 'ensure_dir', path: `.sessions/${conversation}/agents/${agent}/socket` },
      { type: 'ensure_file', path: `.sessions/${conversation}/agents/${agent}/socket/briefing.md` },
      { type: 'ensure_file', path: `.sessions/${conversation}/agents/${agent}/socket/findings.jsonl` },
      { type: 'ensure_dir', path: `.sessions/${conversation}/agents/${agent}/poll-monitors/scripts` },
      { type: 'ensure_dir', path: `.sessions/${conversation}/agents/${agent}/poll-monitors/states` },
      { type: 'ensure_dir', path: `.sessions/${conversation}/agents/${agent}/system/poll-monitors` },
    ] };
  const frame = (id, request) => ({ event_type: 2, sandbox_id: 'sandbox-test-1',
    signature: { device_id: '123456', user_id: '123456' },
    command: { id, name: 'local.workspace.apply', input: JSON.stringify(request), need_ack: true,
      option: { agent_id: agent } } });

  // Live Headless Work has been observed sending append before init.
  await runtime.handleFrame(frame('command-append-before-init', append));
  await runtime.handleFrame(frame('command-init-after-append', init));

  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].body.command_result.code, 0);
  assert.equal(uploads[1].body.command_result.code, 0);
  assert.equal(await fs.readFile(path.join(directory, trajectory), 'utf8'), '{"event":"start"}\n');
  assert.equal(await fs.readFile(path.join(directory, `.sessions/${conversation}/board.md`), 'utf8'), '');
  await fs.rm(directory, { recursive: true, force: true });
});

test('AskOnRisk and AlwaysAsk auto-allow current-session scaffold paths and still gate repo writes', () => {
  assert.equal(isAgentSessionScaffoldPath(`.sessions/${conversationId}/board.md`, conversationId), true);
  assert.equal(isAgentSessionScaffoldPath(`.sessions/${conversationId}/agents/a/system/trajectory.jsonl`, conversationId), true);
  assert.equal(isAgentSessionScaffoldPath('.sessions/9999999999999999/board.md', conversationId), false);
  assert.equal(isAgentSessionScaffoldPath('src/index.ts', conversationId), false);
  assert.equal(isAgentSessionScaffoldPath(`../.sessions/${conversationId}/board.md`, conversationId), false);

  assert.equal(workspaceApplyRequiresApproval('FullAccess', 'denied.txt', conversationId), false);
  assert.equal(workspaceApplyRequiresApproval('AskOnRisk', `.sessions/${conversationId}/memory/MEMORY.md`, conversationId), false);
  assert.equal(workspaceApplyRequiresApproval('AskOnRisk', 'denied.txt', conversationId), true);
  assert.equal(workspaceApplyRequiresApproval('AlwaysAsk', `.sessions/${conversationId}/board.md`, conversationId), false);
  assert.equal(workspaceApplyRequiresApproval('AlwaysAsk', 'denied.txt', conversationId), true);
});

test('workspace apply rejects traversal and requires approval for non-scaffold writes under AskOnRisk', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'headless-runtime-workspace-policy-'));
  let approvals = 0;
  const uploads = [];
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (_route, options) => {
    uploads.push(JSON.parse(options.body));
    return { status_code: 0 };
  } }, ...base({ workspace: directory, permission: 'AskOnRisk', approve: async () => { approvals += 1; return false; } }) });
  const request = { request_id: 'req-2', workspace: { root: directory, session_id: 'session-2', agent_id: 'agent-fixture' },
    operations: [
      { type: 'write_file', path: 'denied.txt', mode: 'replace', content: 'must not write' },
      { type: 'write_file', path: '../escaped.txt', mode: 'replace', content: 'must not escape' },
    ] };
  await runtime.handleFrame({ event_type: 2, sandbox_id: 'sandbox-test-1',
    signature: { device_id: '123456', user_id: '123456' },
    command: { id: 'command-apply-policy', name: 'local.workspace.apply', input: JSON.stringify(request), need_ack: true,
      option: { agent_id: 'agent-fixture' } } });
  assert.equal(approvals, 1);
  await assert.rejects(fs.stat(path.join(directory, 'denied.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(path.dirname(directory), 'escaped.txt')), { code: 'ENOENT' });
  assert.deepEqual(uploads[0].workspace_apply_response.operation_results.map(row => row.error_code), [
    'PERMISSION_DENIED', 'PATH_OUTSIDE_WORKSPACE',
  ]);
  await fs.rm(directory, { recursive: true, force: true });
});

for (const permission of ['AskOnRisk', 'AlwaysAsk']) {
  test(`${permission} applies session scaffold without prompts and still asks before Bash`, async () => {
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `headless-runtime-${permission.toLowerCase()}-scaffold-`));
    const approvals = [];
    const uploads = [];
    const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async (route, options) => {
      uploads.push({ route, body: JSON.parse(options.body) });
      return { status_code: 0 };
    } }, ...base({ workspace: directory, permission, approve: async request => {
      approvals.push(request);
      return request.toolName === 'Bash';
    } }) });
    const scaffoldPath = `.sessions/${conversationId}/agents/agent-fixture/system/trajectory.jsonl`;
    const append = { request_id: 'append_fixture', workspace: { root: directory, session_id: conversationId, agent_id: 'agent-fixture' },
      operations: [{ type: 'write_file', path: scaffoldPath, mode: 'append', content: '{"ok":true}\n' }] };
    const init = { request_id: 'init_fixture', workspace: { root: directory, session_id: conversationId, agent_id: 'agent-fixture' },
      operations: [
        { type: 'ensure_dir', path: `.sessions/${conversationId}/memory` },
        { type: 'ensure_file', path: `.sessions/${conversationId}/board.md` },
        { type: 'ensure_file', path: scaffoldPath },
      ] };
    const commandFrame = (id, request) => ({ event_type: 2, sandbox_id: 'sandbox-test-1',
      signature: { device_id: '123456', user_id: '123456' },
      command: { id, name: 'local.workspace.apply', input: JSON.stringify(request), need_ack: true,
        option: { agent_id: 'agent-fixture' } } });

    await runtime.handleFrame(commandFrame('command-append', append));
    await runtime.handleFrame(commandFrame('command-init', init));
    await runtime.handleFrame(toolFrame({ name: 'Bash', input: { command: 'printf fixture > bash-output.txt' } }));

    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, 'Bash');
    assert.equal(uploads.filter(item => item.route === '/alice/office/tool_local/upload_command_result').length, 2);
    assert.equal(uploads.at(-1).route, '/alice/office/tool_local/upload_tool_call_result');
    assert.equal(await fs.readFile(path.join(directory, scaffoldPath), 'utf8'), '{"ok":true}\n');
    assert.equal(await fs.readFile(path.join(directory, 'bash-output.txt'), 'utf8'), 'fixture');
    await fs.rm(directory, { recursive: true, force: true });
  });
}

test('close releases its lease even after the event loop has already marked the runtime closed', async () => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'headless-runtime-close-'));
  const journalPath = path.join(directory, 'journal.json');
  const runtime = new HeadlessLocalRuntime({ client: { request: async () => responseStream(), json: async () => ({}) },
    ...base(), journalPath });
  await runtime.start();
  runtime.controller.abort(new Error('fixture stop'));
  await runtime.reader.cancel();
  await runtime.loopPromise;
  assert.equal(runtime.state, 'closed');
  await runtime.close();
  await assert.rejects(fs.stat(`${journalPath}.lock`), { code: 'ENOENT' });
  await fs.rm(directory, { recursive: true, force: true });
});
