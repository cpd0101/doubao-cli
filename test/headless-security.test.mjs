import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOptions } from '../src/cli.mjs';
import { resolvePlatform, withApp } from '../src/app.mjs';
import { executeHeadless } from '../src/headless.mjs';
import { receiptStore } from '../src/turns.mjs';
import { HeadlessLocalRuntime, buildHeadlessLocalTaskParam } from '../src/headless-local-runtime.mjs';

const ACCOUNT = '123456789012345678';
const CONVERSATION = '38439138239851266';
const RUN = '38439138239851267';
const app = resolvePlatform('headless');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-security-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const names = ['DOUBAO_CLI_CONFIG_DIR', 'DOUBAO_CLI_DISABLE_AUTO_UPDATE', 'DOUBAO_HEADLESS_COOKIE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.DOUBAO_CLI_CONFIG_DIR = path.join(directory, 'config');
  process.env.DOUBAO_CLI_DISABLE_AUTO_UPDATE = '1';
  delete process.env.DOUBAO_HEADLESS_COOKIE;
  fs.mkdirSync(path.join(directory, 'config', 'headless'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'config', 'headless', 'session.json'), JSON.stringify({
    accountId: ACCOUNT, device: { device_id: '1234567890123', web_id: '1234567890123' }, cookies: [],
  }));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const state = { routes: [], bodies: [], agentParam: {}, finished: true };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const route = new URL(input).pathname;
    state.routes.push(route);
    if (route === '/passport/account/info/v2/') return Response.json({ data: { user_id_str: ACCOUNT } });
    if (route === '/alice/office/tool_local/chunk_stream') {
      return new Response(new ReadableStream({ start() {}, cancel() {} }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (route === '/chat/completion') {
      const body = JSON.parse(init.body);
      state.bodies.push(body);
      state.agentParam = body.option.general_task_param.agent_task_param;
      return new Response(`event: SSE_ACK\ndata: ${JSON.stringify({ ack_client_meta: { conversation_id: CONVERSATION }, query_list: [{ question_id: RUN }] })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }
    if (route === '/im/conversation/batch_get') {
      return Response.json({ status_code: 0, downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{
        conversation_id: CONVERSATION, extra: JSON.stringify({ mode_id: '3', agent_task_param: JSON.stringify(state.agentParam) }),
        messages: [
          { user_type: 1, message_id: RUN, local_message_id: state.bodies.at(-1)?.messages[0].local_message_id || 'fixture' },
          ...(state.finished ? [{ user_type: 2, message_id: '38439138239851269', bot_reply_message_id: RUN,
            ext: { is_finish: '1' }, content_block: [{ content: { text_block: { text: 'finished' } } }] }] : []),
        ],
      }] } } });
    }
    assert.fail(`unexpected route ${route}`);
  });
  const run = (args, dependencies) => withApp(app, () => executeHeadless(parseOptions(['headless', ...args]), dependencies));
  return { directory, workspace, state, run };
}

test('local runtime defaults to AskOnRisk and denies shell mutations without approval', async () => {
  const params = JSON.parse(buildHeadlessLocalTaskParam({ workspace: '/tmp/work', deviceId: '123456' }).general_task_param);
  assert.equal(params.agent_task_param.sandbox_auth_type, 1);
  assert.equal(params.client_option.sandbox_auth_type, 1);
  const runtime = new HeadlessLocalRuntime({ client: { request() {}, json() {} }, sandboxId: 'fixture',
    deviceId: '123456', conversationId: CONVERSATION, workspace: os.tmpdir() });
  assert.equal(runtime.permissionName, 'AskOnRisk');
  const denied = await runtime.execute({ id: 'shell', name: 'Bash', input: { command: 'exit 99' } });
  assert.match(JSON.stringify(denied), /PERMISSION_DENIED/u);
  await runtime.close();
});

test('FullAccess refuses non-TTY and non-true callbacks, while --yes confirms only for this invocation', async t => {
  const fx = fixture(t);
  const absentWorkspace = path.join(fx.directory, 'never-created');
  for (const wait of [[], ['--wait']]) {
    const options = ['sessions', 'create', 'fixture', '--runtime', 'local', '--workspace', absentWorkspace,
      '--permission', 'full-access', ...wait];
    await assert.rejects(fx.run(options), error => error.code === 'FULL_ACCESS_CONFIRMATION_REQUIRED');
    for (const answer of [false, undefined, 'yes', 1]) {
      await assert.rejects(fx.run(options, { confirmFullAccess: async () => answer }),
        error => error.code === 'FULL_ACCESS_CONFIRMATION_REQUIRED');
    }
    // Forged options.fullAccessConfirmed is ignored; only the executeHeadless dependency may pre-confirm.
    const forged = { ...parseOptions(['headless', ...options]), fullAccessConfirmed: true };
    await assert.rejects(withApp(app, () => executeHeadless(forged)), error => error.code === 'FULL_ACCESS_CONFIRMATION_REQUIRED');
  }
  assert.equal(fs.existsSync(absentWorkspace), false);
  assert.ok(fx.state.routes.every(route => route === '/passport/account/info/v2/'));

  const withYes = await fx.run(['sessions', 'create', 'fixture', '--runtime', 'local', '--workspace', fx.workspace,
    '--no-skills', '--permission', 'FullAccess', '--wait', '--yes'], { confirmFullAccess: async () => {
    assert.fail('--yes must not call the interactive FullAccess prompt');
  } });
  assert.equal(withYes.status, 'completed');
  assert.equal(fx.state.bodies.at(-1).option.general_task_param.agent_task_param.sandbox_auth_type, 2);
});

test('local follow-ups inherit FullAccess with fresh consent and honor an explicit permission override', async t => {
  const fx = fixture(t);
  let confirmations = 0;
  const dependencies = { confirmFullAccess: async () => { confirmations += 1; return true; } };
  const first = await fx.run(['sessions', 'create', 'fixture', '--runtime', 'local', '--workspace', fx.workspace,
    '--no-skills', '--permission', 'FullAccess', '--wait'], dependencies);
  assert.equal(first.status, 'completed');
  assert.equal(confirmations, 1);
  assert.equal(fx.state.bodies[0].option.general_task_param.agent_task_param.sandbox_auth_type, 2);
  const store = await withApp(app, () => receiptStore({ accountId: ACCOUNT }));
  assert.equal(store.read(CONVERSATION, RUN).localRuntime.permission, 'FullAccess');
  assert.equal(store.read(CONVERSATION, RUN).fullAccessConfirmed, undefined);
  await assert.rejects(fx.run(['sessions', 'send', CONVERSATION, 'fixture', '--permission', 'FullAccess', '--wait']),
    error => error.code === 'FULL_ACCESS_CONFIRMATION_REQUIRED');
  await assert.rejects(fx.run(['sessions', 'send', CONVERSATION, 'fixture', '--wait']),
    error => error.code === 'FULL_ACCESS_CONFIRMATION_REQUIRED');
  assert.equal(fx.state.bodies.length, 1);
  const inherited = await fx.run(['sessions', 'send', CONVERSATION, 'fixture', '--no-skills', '--wait'], dependencies);
  assert.equal(inherited.status, 'completed');
  assert.equal(confirmations, 2);
  assert.equal(fx.state.bodies.at(-1).option.general_task_param.agent_task_param.sandbox_auth_type, 2);
  assert.equal(fx.state.bodies.at(-1).option.general_task_param.agent_task_param_change.sandbox_auth_type_changed, false);
  const next = await fx.run(['sessions', 'send', CONVERSATION, 'fixture', '--no-skills', '--permission', 'AskOnRisk', '--wait']);
  assert.equal(next.status, 'completed');
  const body = fx.state.bodies.at(-1).option.general_task_param;
  assert.equal(body.agent_task_param.runtime_type, 2);
  assert.equal(body.agent_task_param.sandbox_auth_type, 1);
  assert.equal(body.agent_task_param_change.sandbox_auth_type_changed, true);
  assert.equal(store.read(CONVERSATION, RUN).localRuntime.permission, 'AskOnRisk');
  await fx.run(['sessions', 'send', CONVERSATION, 'fixture', '--no-skills', '--wait']);
  assert.equal(fx.state.bodies.at(-1).option.general_task_param.agent_task_param.sandbox_auth_type, 1);
});

test('restricted local permissions also survive follow-ups without an explicit override', async t => {
  const fx = fixture(t);
  for (const [name, value] of [['AlwaysAsk', 0], ['AskOnRisk', 1]]) {
    await fx.run(['sessions', 'create', 'fixture', '--runtime', 'local', '--workspace', fx.workspace,
      '--no-skills', '--permission', name, '--wait']);
    await fx.run(['sessions', 'send', CONVERSATION, 'fixture', '--no-skills', '--wait']);
    assert.equal(fx.state.bodies.at(-1).option.general_task_param.agent_task_param.sandbox_auth_type, value);
    assert.equal(fx.state.bodies.at(-1).option.general_task_param.agent_task_param_change.sandbox_auth_type_changed, false);
  }
});

test('recovering a FullAccess receipt requires fresh confirmation before starting the local channel', async t => {
  const fx = fixture(t);
  fx.state.finished = false;
  const store = await withApp(app, () => receiptStore({ accountId: ACCOUNT }));
  store.save({ conversationId: CONVERSATION, runId: RUN, accepted: true,
    localRuntime: { workspace: fx.workspace, sandboxId: 'fixture', deviceId: '123456', permission: 'FullAccess' } });
  await assert.rejects(fx.run(['sessions', 'wait', CONVERSATION, '--run', RUN]),
    error => error.code === 'FULL_ACCESS_CONFIRMATION_REQUIRED');
  assert.equal(fx.state.routes.includes('/alice/office/tool_local/chunk_stream'), false);
  assert.equal(fx.state.bodies.length, 0);

  await assert.rejects(fx.run(['sessions', 'wait', CONVERSATION, '--run', RUN, '--yes', '--timeout', '1'], {
    confirmFullAccess: async () => assert.fail('--yes must not call the interactive FullAccess prompt'),
  }), error => error.code === 'timeout' || /timed out/iu.test(error.message));
  assert.equal(fx.state.routes.includes('/alice/office/tool_local/chunk_stream'), true);
});
