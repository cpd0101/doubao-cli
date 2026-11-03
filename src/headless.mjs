import { SESSION_ACTIONS, sessionMutationInput, mutateApiSession } from './session-actions.mjs';
import fs from 'node:fs/promises';
import { completionBody } from './headless-completion.mjs';
export { completionBody } from './headless-completion.mjs';
import { waitWithLocalRuntime } from './headless-turn.mjs';
import { requireGoalMode, GOAL_MIN_VERSION } from './features.mjs';
import { createScheduledTaskService } from './scheduled-tasks.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import qrcode from 'qrcode-terminal';
import { headlessProfilePaths, listHeadlessProfiles, loadHeadlessState, updateHeadlessState, validateHeadlessProfileName } from './headless-state.mjs';
import { listHeadlessSessions, listHeadlessProjects, createHeadlessProject, headlessEnterpriseSkill, readHeadlessUsage, readHeadlessConversation, modifyHeadlessModel, headlessProfileMetadata } from './headless-services.mjs';
import { resolveModelName, resolveReasoningEffort } from './models.mjs';
import { parseConversationContext } from './task-context.mjs';
import { resolveHeadlessTaskContext } from './headless-context.mjs';
import { configDirectory } from './config.mjs';
import { resolveAttachmentFiles } from './attachments.mjs';
import { uploadHeadlessAttachments } from './headless-attachments.mjs';
import { HeadlessConnectors } from './headless-mcp.mjs';
import { HeadlessLocalRuntime, buildHeadlessLocalTaskParam, prepareHeadlessLocalChannel } from './headless-local-runtime.mjs';
import { createHeadlessApproval, confirmHeadlessFullAccess } from './headless-approval.mjs';
import { resolvePermission } from './permissions.mjs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { CookieJar, HeadlessClient, consumeSse, HEADLESS_PROTOCOL_VERSION } from './headless-http.mjs';
import { qrLogin } from './headless-auth.mjs';
import { reduceStreamEvent, updateLiveControls } from './protocol.mjs';
import { messageText, readTurn, refreshTurn, waitTurn, stopTurn, receiptStore } from './turns.mjs';

const ID = /^[1-9]\d{11,23}$/u;
const sessionPath = profile => headlessProfilePaths({ profile }).credentials;
const validateId = value => { if (!ID.test(value || '')) throw new Error('conversation id must contain 12 to 24 digits'); return value; };

export function validateHeadlessOptions(options) {
  const [command, subcommand] = options.args;
  if (!command || ['help', 'version', '--version', '-v', 'update', 'skin'].includes(command)) return;
  const unsupported = [
    ['--target', options.targetId],
  ].find(([, supplied]) => supplied);
  if (unsupported) throw new Error(`${unsupported[0]} is not supported on doubao headless`);
  if (options.profile) validateHeadlessProfileName(options.profile);
  if (options.unknownFlags?.length) throw new Error(`Unknown Headless option: ${options.unknownFlags[0]}; use -- before literal option text`);
  if (options.cookieFile && command !== 'login') throw new Error('--cookie-file requires doubao headless login');
  const supported = ['login', 'logout', 'status', 'capabilities', 'models', 'profiles', 'usage', 'runtimes'].includes(command)
    || command === 'keepalive' && ['status', 'stop'].includes(subcommand)
    || command === 'sessions' && ['list', 'current', 'open', 'read', 'create', 'send', 'status', 'wait', 'stop', ...SESSION_ACTIONS].includes(subcommand)
    || command === 'automations' && ['list', 'get', 'create', 'update', 'delete'].includes(subcommand)
    || command === 'projects' && ['list', 'create'].includes(subcommand)
    || command === 'mcp' && ['register', 'list', 'remove'].includes(subcommand)
    || command === 'model' && (!subcommand || ['current', 'select', 'reasoning'].includes(subcommand));
  if (!supported) throw new Error(`${options.args.slice(0, 2).join(' ')} is not supported on doubao headless`);
  if (['login', 'logout', 'status', 'capabilities', 'models'].includes(command) && options.args.length !== 1) throw new Error(`${command} accepts no positional arguments`);
  if (command === 'keepalive') {
    if (!['status', 'stop'].includes(subcommand)) throw new Error('keepalive requires status or stop');
    if (options.args.length !== 2) throw new Error(`keepalive ${subcommand} accepts no positional arguments`);
  }
  if (options.reasoning) resolveReasoningEffort(options.reasoning);
  if (options.wait && (command !== 'sessions' || !['create', 'send'].includes(subcommand)
    || !options.args.slice(subcommand === 'create' ? 2 : 3).join(' ').trim())) throw new Error('Headless --wait requires sessions create/send with a message');
  if (options.model && (command !== 'sessions' || !['create', 'send'].includes(subcommand))) throw new Error('--model requires headless sessions create/send');
}

async function saveSession(client, profile = client.profile) {
  const file = sessionPath(profile);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({ accountId: client.accountId, device: client.device, cookies: client.jar.cookies }), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function signedInClient(timeoutMs, profile) {
  let session;
  try { session = JSON.parse(await fs.readFile(sessionPath(profile), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Headless session file is invalid; log in again'); }
  const cookie = process.env.DOUBAO_HEADLESS_COOKIE;
  if (!cookie && !session) throw Object.assign(new Error('Doubao login is required; run "doubao headless login"'), { code: 'login_required' });
  const client = new HeadlessClient({ ...(session || {}), ...(cookie ? { cookies: CookieJar.import(cookie), accountId: undefined } : {}) });
  client.profile = profile;
  await client.account({ timeoutMs });
  if (!cookie) await saveSession(client);
  attachLifecycle(client);
  return client;
}

/**
 * Headless Local command transport: `sse` (default, `/chunk_stream`)
 * or `ws` (Desktop-aligned command websocket). Alias: `frontier-ws`/`frontier` → ws.
 */
export function resolveHeadlessLocalTransport(env = process.env) {
  const raw = String(env?.DOUBAO_HEADLESS_LOCAL_TRANSPORT || 'sse').trim().toLowerCase();
  if (raw === 'ws' || raw === 'frontier-ws' || raw === 'frontier') return 'ws';
  if (raw === 'sse' || raw === '') return 'sse';
  return 'sse';
}

/**
 * Cross-CLI local keepalive (ws Frontier hub + sse sticky-sandbox hub).
 * Off via DOUBAO_HEADLESS_FRONTIER_KEEPALIVE=0; unsupported on win32.
 */
export function resolveFrontierKeepaliveEnabled(env = process.env) {
  if (process.platform === 'win32') return false;
  const raw = String(env?.DOUBAO_HEADLESS_FRONTIER_KEEPALIVE ?? '1').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * Early STREAM_CHUNKs after REPLYING clears are often just an opening fence
 * (` ``` `). Treat those as incomplete so we keep the grace window / IM poll.
 */
export function isIncompleteEarlyReply(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  const fences = value.match(/```/g);
  if (fences && fences.length % 2 === 1) return true;
  return false;
}

export async function streamCompletion(client, body, {
  timeoutMs, waitForReply = false, onReceipt = () => {}, runId = '', signal,
  // Optional Frontier tracker (diagnostics / legacy). Early-complete uses end_type=1.
  agentStatus = null,
  // After end_type=1, briefly allow IM to upgrade a truncated stream answer.
  earlyAnswerGraceMs = 3_000,
  // Desktop stops its local spinner at SSE end_type=1 (MsgFinish) when it owns the
  // completion stream. Server is_loading stays 1 until end_type=3; bystander Doubao UI
  // only clears then. Return to the CLI on end_type=1, and keep draining this SSE in
  // the keepalive hub until end_type=3 so the server can clear is_loading. drainMs=0
  // cancels immediately (tests).
  earlyStreamDrainMs = 120_000,
} = {}) {
  const state = { conversationId: body.client_meta.conversation_id, runId, localMessageId: body.messages[0].local_message_id,
    answer: '', thinking: '', completed: false, handoffs: [], liveMessages: [], requestBody: body, accepted: false, requestDispatched: false,
    earlyComplete: null, uiSettled: null, streamFinished: null, streamDrain: null };
  const checkpoint = () => onReceipt({ ...state });
  let signalReady;
  const ready = new Promise(resolve => { signalReady = resolve; });
  const markReady = () => {
    try { signalReady?.(state); } catch {}
    signalReady = null;
  };

  const work = (async () => {
    try {
      state.requestDispatched = true;
      const response = await client.request('/chat/completion', { method: 'POST', timeoutMs, ...(signal ? { signal } : {}),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const streamStarted = Date.now();
      const timing = process.env.DOUBAO_HEADLESS_TIMING === '1';
      let firstAnswerAt = 0;
      let drainTimer = null;
      // body.cancel() alone can leave consumeSse blocked on reader.read() until the
      // server closes (~end_type=3). Abort this signal so the drain window can end.
      const streamStop = new AbortController();
      const forceCloseStream = async (reason) => {
        try { streamStop.abort(new DOMException(reason || 'Early complete', 'AbortError')); } catch {}
        try { await response.body?.cancel?.(); } catch {}
      };
      const armStreamDrain = () => {
        const drainMs = Math.max(0, Number(earlyStreamDrainMs) || 0);
        if (drainMs <= 0) {
          void forceCloseStream('Early complete');
          return;
        }
        if (drainTimer) return;
        drainTimer = setTimeout(() => {
          state.streamFinished = state.streamFinished || 'drain_timeout';
          if (timing) {
            console.error(`[headless-timing] completion_stream_drain_timeout +${Date.now() - streamStarted}ms`);
          }
          void forceCloseStream('Early stream drain timeout');
        }, drainMs);
        // Do not unref: the keepalive hub must stay alive until drain finishes after
        // the CLI RPC returns, otherwise end_type=3 never arrives and the UI spins.
      };
      const stopEarly = async (reason) => {
        if (state.earlyComplete) return;
        state.earlyComplete = reason || 'end_type_1';
        state.completed = true;
        if (timing) {
          console.error(`[headless-timing] completion_early_complete +${Date.now() - streamStarted}ms reason=${state.earlyComplete} answer=${JSON.stringify(String(state.answer || '').slice(0, 40))}`);
        }
        // Keep reading until end_type=3 so the server can clear conversation is_loading.
        armStreamDrain();
        markReady();
      };
      const upgradeAnswerFromIm = async () => {
        const waitMs = Math.max(0, Number(earlyAnswerGraceMs) || 0);
        if (!waitMs || !state.conversationId) return;
        const imDeadline = Date.now() + waitMs;
        // end_type=1 brief is sometimes a placeholder like "[代码]" while IM already
        // has the full reply — always prefer a longer IM/stream snapshot.
        while (Date.now() < imDeadline) {
          const snapshot = await readTurn(client, state.conversationId, {
            runId: state.runId || runId, localMessageId: state.localMessageId,
            deadline: imDeadline,
          }).catch(() => null);
          const text = String(snapshot?.result?.reply?.text || snapshot?.result?.progress || '').trim();
          if (text && text.length > String(state.answer || '').trim().length) {
            state.answer = text;
            if (timing) console.error(`[headless-timing] completion_im_answer +${Date.now() - streamStarted}ms chars=${text.length}`);
          }
          const current = String(state.answer || '').trim();
          if (current && !isIncompleteEarlyReply(current) && !/^\[[^\]]{1,12}\]$/u.test(current)) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      try {
        await consumeSse(response, async (event, data) => {
          if (timing && event === 'FETCH_STREAM') {
            console.error(`[headless-timing] completion_fetch_stream +${Date.now() - streamStarted}ms type=${data?.fetch_type} key=${data?.fetch_key || ''}`);
          }
          if (timing && event === 'SSE_REPLY_END') {
            console.error(`[headless-timing] completion_reply_end +${Date.now() - streamStarted}ms end_type=${data?.end_type} brief=${JSON.stringify(String(data?.msg_finish_attr?.brief || '').slice(0, 40))}`);
          }
          if (state.earlyComplete) {
            if (timing && event !== 'SSE_REPLY_END') {
              console.error(`[headless-timing] completion_drain_event +${Date.now() - streamStarted}ms event=${event}`);
            }
            if (event === 'SSE_REPLY_END' && Number(data?.end_type) === 3) {
              state.streamFinished = 'end_type_3';
              if (drainTimer) clearTimeout(drainTimer);
              drainTimer = null;
              if (timing) console.error(`[headless-timing] completion_stream_drained +${Date.now() - streamStarted}ms`);
              try { streamStop.abort(new DOMException('Completion finished', 'AbortError')); } catch {}
              return 'stop';
            }
            return undefined;
          }
          if (event === 'SSE_ACK') {
            const id = String(data?.ack_client_meta?.conversation_id || '');
            const acceptedRun = String(data?.query_list?.[0]?.question_id || '');
            const acceptedLocalId = data?.query_list?.[0]?.local_message_id;
            if (!ID.test(id) || !ID.test(acceptedRun) || state.conversationId && id !== state.conversationId
              || acceptedLocalId && acceptedLocalId !== state.localMessageId
              || runId && runId !== acceptedRun) throw new Error('Doubao returned a mismatched acceptance receipt');
            state.accepted = true;
            state.conversationId = id;
            if (timing) console.error(`[headless-timing] completion_ack +${Date.now() - streamStarted}ms`);
          }
          // A Work ACK can precede provisioning its asynchronous task. Keep the
          // initial stream until a handoff or terminal event even without --wait.
          const beforeAnswer = state.answer;
          const result = reduceStreamEvent(state, event, data, { waitForReply: waitForReply || body.option.agent_mode === 1 });
          if (timing && !firstAnswerAt && state.answer && state.answer !== beforeAnswer) {
            firstAnswerAt = Date.now();
            console.error(`[headless-timing] completion_first_answer +${firstAnswerAt - streamStarted}ms text=${JSON.stringify(state.answer.slice(0, 40))}`);
          }
          // Desktop MsgFinish (end_type=1): CLI can return; keep SSE open until ReplyFinish (3).
          if (event === 'SSE_REPLY_END' && Number(data?.end_type) === 1 && waitForReply) {
            void (async () => {
              await upgradeAnswerFromIm();
              if (String(state.answer || '').trim()) await stopEarly('end_type_1');
            })();
            return undefined;
          }
          const pending = updateLiveControls(state, event, data);
          if (event === 'SSE_ACK' || event === 'FETCH_STREAM' || pending) checkpoint();
          if (event === 'STREAM_ERROR' || event === 'gateway-error') throw Object.assign(new Error('Doubao completion failed'), { code: 'stream_error' });
          if (event === 'SSE_ACK' && body.option.general_task_param.runtime_type === 2 && !waitForReply) return 'stop';
          return result || (pending || state.accepted && state.handoffs.length ? 'stop' : undefined);
        }, { signal: streamStop.signal });
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
        markReady();
      }
      if (timing) console.error(`[headless-timing] completion_stream_done +${Date.now() - streamStarted}ms answer=${JSON.stringify(state.answer.slice(0, 40))} handoffs=${state.handoffs.length} completed=${state.completed} early=${state.earlyComplete || ''} finished=${state.streamFinished || ''}`);
      if (!state.accepted) throw new Error('Completion ended without a verified acceptance receipt');
      checkpoint();
      return state;
    } catch (error) {
      // A failed receipt write must not erase the server's accepted IDs.
      try { checkpoint(); } catch {}
      markReady();
      if (typeof error.code !== 'string') error = Object.assign(new Error(error.message, { cause: error }), {
        name: error.name, code: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'request_failed',
      });
      error.result = { platform: 'headless', conversationId: state.conversationId || null, runId: state.runId || null,
        localMessageId: state.localMessageId, accepted: state.accepted, requestDispatched: state.requestDispatched, status: state.failed ? 'failed' : 'unknown', reply: null,
        recovery: state.accepted ? 'Use sessions wait with the same conversationId and runId; do not resend' : 'Acceptance is unknown; inspect session history before retrying' };
      throw error;
    }
  })();

  state.streamDrain = work;
  await Promise.race([ready, work]);
  const detach = Boolean(state.earlyComplete) && Math.max(0, Number(earlyStreamDrainMs) || 0) > 0;
  if (!detach) return work;
  if (!state.accepted) return work;
  checkpoint();
  return state;
}

function attachLifecycle(client) {
  client.resumeCompletion = async options => {
    // Server recovery reopens this exact request; it is never a new user send.
    const body = structuredClone(options.resumeRequest);
    body.option.recovery_option.is_recovery = true;
    return streamCompletion(client, body, options);
  };
  client.followTaskStreams = async (receipt, timeoutMs, onReceipt = () => {}) => {
    const deadline = Date.now() + timeoutMs;
    const controls = { liveMessages: receipt.liveMessages || [] };
    for (let index = 0; index < receipt.handoffs.length && Date.now() < deadline; index++) {
      const task = receipt.handoffs[index];
      if (task.completed) continue;
      delete task.waitingInput;
      try {
        const response = await client.request('/chat/async/chunk_stream', { method: 'POST', timeoutMs: Math.max(1, deadline - Date.now()),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: task.taskId, seq_start: task.seq || 0, append_scene: task.appendScene, ext: {} }) });
        await consumeSse(response, (event, data, id) => {
          const seq = Number(id);
          if (Number.isFinite(seq) && seq > 0 && seq <= (task.seq || 0)) return;
          if (Number.isFinite(seq)) task.seq = Math.max(task.seq || 0, seq);
          if (event === 'ASYNC_CHUNK_SNAPSHOT') task.seq = Math.max(task.seq || 0, Number(data.next_seq) || 0);
          if (event === 'FETCH_STREAM' && data.fetch_type === 2 && data.fetch_key && !receipt.handoffs.some(item => item.taskId === String(data.fetch_key))) {
            if (receipt.handoffs.length >= 100) throw new Error('Async task stream limit exceeded');
            receipt.handoffs.push({ taskId: String(data.fetch_key), appendScene: data.append_scene, threadId: data.thread_id || '', seq: 0 });
          }
          if (updateLiveControls(controls, event, data)) { task.waitingInput = true; return 'stop'; }
          if (event === 'SSE_REPLY_END' && data.end_type === 3) { task.completed = true; return 'stop'; }
          if (event === 'STREAM_ERROR' || event === 'gateway-error') { task.error = 'stream_error'; task.completed = true; return 'stop'; }
          receipt.liveMessages = controls.liveMessages;
          onReceipt(receipt);
        });
        delete task.connectionError;
      } catch (error) { task.connectionError = error.code || error.name; }
      finally { receipt.liveMessages = controls.liveMessages; onReceipt(receipt); }
    }
  };
}

/** List only persisted profiles, enriching cached identities through one saved profile session. */
export async function listHeadlessProfileMetadata({ configDir, timeoutMs = 15_000, clientFactory, metadataReader = headlessProfileMetadata } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw Object.assign(new Error('Headless request timed out'), { code: 'timeout' });
    return value;
  };
  const names = await listHeadlessProfiles({ configDir });
  const profiles = await Promise.all(names.map(async name => {
    let account = null;
    try {
      const sessionFile = headlessProfilePaths({ profile: name, configDir }).credentials;
      const session = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
      if (session && typeof session === 'object' && !Array.isArray(session) && /^[1-9]\d{5,24}$/u.test(session.accountId || '')) {
        account = { id: session.accountId, name: null, type: 'unknown', enterpriseUserType: null, tenant: null, source: 'cache' };
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return { directory: name, name, account };
  }));

  const ids = profiles.map(row => row.account?.id).filter(Boolean);
  const metadataProfile = profiles.find(row => row.name === 'default' && row.account)?.name
    || profiles.find(row => row.account)?.name || null;
  let accountLookupError = ids.length ? 'login_required' : 'account_identity_unavailable';
  if (metadataProfile) {
    try {
      const sourceSession = JSON.parse(await fs.readFile(headlessProfilePaths({ profile: metadataProfile, configDir }).credentials, 'utf8'));
      const makeClient = clientFactory || (async (budget, _profile, session) => {
        const client = new HeadlessClient(session);
        client.profile = _profile;
        await client.account({ timeoutMs: budget });
        return client;
      });
      const client = await makeClient(remaining(), metadataProfile, sourceSession);
      if (client?.accountId !== sourceSession.accountId) {
        throw Object.assign(new Error('Saved profile account identity changed'), { code: 'account_changed' });
      }
      const metadata = await metadataReader(client, ids, remaining());
      for (const row of profiles) {
        const live = metadata?.accounts?.[row.account?.id];
        if (live) row.account = live;
      }
      accountLookupError = metadata?.incompleteReason ?? null;
    } catch (error) {
      accountLookupError = error.code === 'login_required' ? 'login_required'
        : error.code === 'timeout' ? 'timeout'
          : error.code === 'account_changed' ? 'account_changed' : 'account_lookup_failed';
    }
  }
  return { defaultProfile: 'default', metadataProfile, profiles, accountLookupError };
}

export async function executeHeadless(options, { confirmFullAccess = confirmHeadlessFullAccess, fullAccessConfirmed = false } = {}) {
  // Consent is scoped to this invocation and never persisted in a recovery receipt.
  // `--yes` may confirm for the current create/send/wait only.
  const authorizeFullAccess = async workspace => {
    if (fullAccessConfirmed === true) return;
    if (options.yes === true) {
      fullAccessConfirmed = true;
      return;
    }
    if (await confirmFullAccess({ workspace }) !== true) {
      throw Object.assign(new Error('FullAccess requires explicit confirmation in an interactive terminal or --yes; use AskOnRisk or AlwaysAsk otherwise'),
        { code: 'FULL_ACCESS_CONFIRMATION_REQUIRED' });
    }
    fullAccessConfirmed = true;
  };
  const [command, subcommand, operand] = options.args;
  const profile = validateHeadlessProfileName(options.profile || 'default');
  const started = Date.now(), deadline = started + options.timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw Object.assign(new Error('Headless request timed out'), { code: 'timeout' }); return ms; };
  if (command === 'capabilities') return { platform: 'headless', browserRequired: false, appRequired: false,
    login: ['terminal-qr', 'cookie-file'], sessions: ['list', 'current', 'open', 'read', 'create', 'send', 'status', 'wait', 'stop', ...SESSION_ACTIONS],
    runtime: ['cloud', 'local'], models: true, modelSelection: true, reasoning: true, profiles: true, usage: true,
    keepalive: ['status', 'stop'],
    goalMode: { supported: true, minimumVersion: GOAL_MIN_VERSION, protocolVersion: HEADLESS_PROTOCOL_VERSION, accountGate: 'goal_mode_enable' },
    automations: ['list', 'get', 'create', 'update', 'delete'],
    attachments: true, localRuntime: true, mcp: true, projects: true, enterpriseKnowledgeSelection: true,
    note: 'open/current select the CLI conversation; model defaults are scoped to the profile and account' };
  if (command === 'keepalive') {
    const transport = resolveHeadlessLocalTransport();
    if (transport === 'sse') {
      const { inspectSseHub, stopSseHub } = await import('./headless-sse-hub.mjs');
      if (subcommand === 'status') {
        const hub = await inspectSseHub({ profile, configDir: configDirectory() });
        return { platform: 'headless', profile, transport: 'sse', keepalive: hub };
      }
      const stopped = await stopSseHub({ profile, configDir: configDirectory() });
      return { platform: 'headless', ...stopped };
    }
    const { inspectFrontierHub, stopFrontierHub } = await import('./headless-frontier-hub.mjs');
    if (subcommand === 'status') {
      const hub = await inspectFrontierHub({ profile, configDir: configDirectory() });
      return { platform: 'headless', profile, transport: 'ws', keepalive: hub };
    }
    const stopped = await stopFrontierHub({ profile, configDir: configDirectory() });
    return { platform: 'headless', ...stopped };
  }
  if (command === 'profiles') {
    return { platform: 'headless', ...await listHeadlessProfileMetadata({ timeoutMs: remaining() }) };
  }
  if (command === 'logout') {
    await fs.rm(sessionPath(profile), { force: true });
    await fs.rm(headlessProfilePaths({ profile }).state, { force: true });
    return { platform: 'headless', profile, storedCredentialsRemoved: true, loggedIn: false,
      environmentCredentialActive: Boolean(process.env.DOUBAO_HEADLESS_COOKIE) };
  }
  if (command === 'login') {
    const cookie = options.cookieFile ? await fs.readFile(options.cookieFile, 'utf8') : process.env.DOUBAO_HEADLESS_COOKIE;
    const client = new HeadlessClient({ ...(cookie ? { cookies: CookieJar.import(cookie) } : {}) });
    client.profile = profile;
    if (cookie) await client.account({ timeoutMs: remaining() });
    else await qrLogin(client, { timeoutMs: remaining(), onQr: ({ url }) => {
      if (!url) throw new Error('Doubao QR response has no scannable login URL');
      console.error('Scan with the Doubao mobile app and approve sign-in:');
      qrcode.generate(url, { small: true }, value => console.error(value));
    } });
    await saveSession(client);
    return { platform: 'headless', profile, loggedIn: true, accountId: client.accountId, browserRequired: false, appRequired: false };
  }
  let client;
  try { client = await signedInClient(remaining(), profile); }
  catch (error) {
    if (command !== 'status' || error.code !== 'login_required') throw error;
    return { platform: 'headless', profile, loggedIn: false, loginRequired: true, accountId: null, browserRequired: false, appRequired: false };
  }
  if (options.expectedAccountId && client.accountId !== options.expectedAccountId) {
    throw Object.assign(new Error('Headless account changed before background submission'), { code: 'account_changed' });
  }
  if (command === 'status') return { platform: 'headless', profile, loggedIn: true, loginRequired: false, accountId: client.accountId, browserRequired: false, appRequired: false };
  if (command === 'automations') {
    const service = createScheduledTaskService(client, { timeoutMs: remaining() });
    const result = subcommand === 'list' ? { automations: await service.list() }
      : subcommand === 'get' ? { automation: await service.get(operand) || null }
      : subcommand === 'create' ? await service.create(options.automationInput)
      : subcommand === 'update' ? await service.update(operand, options.automationInput) : await service.delete(operand);
    return { platform: 'headless', ...result };
  }
  if (command === 'usage') return { platform: 'headless', ...await readHeadlessUsage(client, remaining()) };
  if (command === 'runtimes') return { platform: 'headless', profile, runtimes: [
    { id: 'cloud', name: '云端', available: true },
    { id: 'local', name: '本地电脑', available: true, deviceId: client.device.device_id, deviceName: os.hostname(),
      engine: resolveHeadlessLocalTransport() === 'ws' ? 'node-ws' : 'node-sse',
      hostPlatform: process.platform },
  ] };
  if (command === 'mcp') {
    const connectors = new HeadlessConnectors({ client, profile, accountId: client.accountId, requestTimeoutMs: remaining(), deadlineMs: deadline });
    try {
      if (subcommand === 'list') return { platform: 'headless', connectors: await connectors.list() };
      if (subcommand === 'remove') return { platform: 'headless', ...await connectors.remove(operand) };
      return { platform: 'headless', ...await connectors.register({ name: options.args.slice(2).join(' '), command: options.commandPath,
        params: options.commandArgs, env: Object.fromEntries(options.envPairs.map(pair => { const index = pair.indexOf('='); return [pair.slice(0, index), pair.slice(index + 1)]; })) }) };
    } finally { await connectors.close(); }
  }
  if (command === 'projects') {
    if (subcommand === 'list') return { platform: 'headless', projects: await listHeadlessProjects(client, remaining()) };
    return { platform: 'headless', ...await createHeadlessProject(client, { name: options.args.slice(2).join(' '), workspace: options.workspace,
      deviceId: client.device.device_id, deviceName: os.hostname() }, remaining()) };
  }
  const state = await loadHeadlessState({ profile, accountId: client.accountId });
  if (command === 'model') {
    if (!subcommand || subcommand === 'current') {
      const conversation = state.currentConversationId ? await readHeadlessConversation(client, state.currentConversationId, remaining()) : null;
      const extra = parseExtra(conversation?.extra);
      const id = extra.model_item_key || state.defaults.modelId;
      const catalog = id ? await headlessModels(client, remaining()) : null;
      return { platform: 'headless', profile, conversationId: state.currentConversationId,
        id, name: catalog?.models.find(model => model.id === id)?.name || null, reasoning: reasoningName(extra.reasoning_effort) || state.defaults.reasoning,
        scope: conversation ? 'conversation' : 'new-conversations' };
    }
    const conversation = state.currentConversationId ? await readHeadlessConversation(client, state.currentConversationId, remaining()) : null;
    const extra = parseExtra(conversation?.extra);
    const reasoning = subcommand === 'reasoning' ? resolveReasoningEffort(options.args.slice(2).join(' '))
      : options.reasoning ? resolveReasoningEffort(options.reasoning) : null;
    const requested = subcommand === 'select' ? options.args.slice(2).join(' ')
      : extra.model_item_key || state.defaults.modelId;
    if (!requested) throw new Error('Select a model first with "doubao headless model select <model>"');
    const mode = extra.mode_id === '1' ? 'chat' : conversation ? 'work' : undefined;
    const model = await resolveHeadlessModel(client, subcommand === 'select' ? { name: requested } : { id: requested }, mode, remaining());
    if (conversation) await modifyHeadlessModel(client, state.currentConversationId, model.id,
      reasoning?.effort || extra.reasoning_effort || '5', remaining());
    await updateHeadlessState({ profile, accountId: client.accountId, defaults: { modelId: model.id, ...(reasoning ? { reasoning: reasoning.name } : {}) } });
    return { platform: 'headless', profile, id: model.id, name: model.name, changed: true,
      conversationId: state.currentConversationId, scope: conversation ? 'conversation-and-new-conversations' : 'new-conversations',
      ...(reasoning ? { reasoning: reasoning.name } : {}) };
  }
  if (command === 'models') return headlessModels(client, remaining());
  if (command !== 'sessions') throw new Error('Unknown headless command');
  if (SESSION_ACTIONS.includes(subcommand)) {
    const input = sessionMutationInput(subcommand, operand, options.args.slice(3).join(' '));
    return { platform: 'headless', ...await mutateApiSession(client, input, remaining()) };
  }
  if (subcommand === 'list') return listHeadlessSessions(client, { limit: options.limit, all: options.all, archived: options.archived, timeoutMs: remaining() });
  if (subcommand === 'open' || subcommand === 'current') {
    const id = subcommand === 'open' ? validateId(operand) : state.currentConversationId;
    if (!id) throw new Error('No current Headless conversation; use "doubao headless sessions open <id>" or create one');
    const conversation = await readHeadlessConversation(client, id, remaining());
    if (subcommand === 'open') await updateHeadlessState({ profile, accountId: client.accountId, currentConversationId: id });
    return { platform: 'headless', profile, id, title: conversation.name || null, selected: true, browserOpened: false };
  }
  if (subcommand === 'read') {
    const body = await client.imRequest('conversation/batch_get', 1111, 'batch_get_conv_info_uplink_body', {
      conversation_id: [validateId(operand)], option: { recent_message_count_per_conv: Math.min(options.limit, 100) }, ext: {} }, remaining());
    const conversation = body?.batch_get_conv_info_downlink_body?.conversation_info_list?.find(item => item.conversation_id === operand);
    if (!conversation) throw new Error('Doubao conversation was not found');
    return { platform: 'headless', conversationId: operand, messages: (conversation.messages || []).map(message => ({
      role: message.user_type === 1 ? 'user' : 'assistant', text: messageText(message), messageId: message.message_id })) };
  }
  const store = await receiptStore(client);
  if (['create', 'send'].includes(subcommand)) {
    const message = options.args.slice(subcommand === 'create' ? 2 : 3).join(' ').trim();
    if (!message) {
      if (subcommand !== 'create') throw new Error('Headless sessions send requires a message');
      await updateHeadlessState({ profile, accountId: client.accountId, currentConversationId: null });
      return { platform: 'headless', conversationId: null, sent: null, draft: true };
    }
    const conversationId = subcommand === 'send' ? validateId(operand) : '';
    let mode = options.mode || 'work';
    const goalId = mode === 'goal' ? randomUUID() : undefined;
    if (goalId) await requireGoalMode(client, HEADLESS_PROTOCOL_VERSION, remaining());
    let conversation;
    let previous = parseConversationContext();
    if (conversationId) {
      conversation = (await readTurn(client, conversationId, { deadline })).conversation;
      previous = parseConversationContext(conversation);
      mode = previous.extra.mode_id === '1' ? 'chat' : 'work';
    }
    const resolved = await resolveHeadlessTaskContext(client, conversationId, options, { conversation, profile, timeoutMs: remaining() });
    const taskContext = resolved.taskContext, runtimeChoice = taskContext.runtime, localPermission = resolved.permission;
    if (mode === 'chat' && (runtimeChoice === 'local' || taskContext.projectId || options.enterpriseKnowledge)) throw new Error('Local runtime, projects and enterprise knowledge require --mode work');
    if (runtimeChoice === 'local' && localPermission === 'FullAccess') await authorizeFullAccess(resolved.workspace);
    const selectedModel = options.model || (!conversationId ? state.defaults.modelId : undefined);
    const selectedReasoning = options.reasoning || (!conversationId ? state.defaults.reasoning : undefined);
    const reasoning = selectedReasoning ? resolveReasoningEffort(selectedReasoning).effort : undefined;
    const model = selectedModel ? await resolveHeadlessModel(client, options.model ? { name: selectedModel } : { id: selectedModel }, mode === 'goal' ? 'work' : mode, remaining())
      : reasoning ? await resolveHeadlessModel(client, { id: previous.extra?.model_item_key || '9' }, mode === 'goal' ? 'work' : mode, remaining()) : undefined;
    if (runtimeChoice === 'local' && !options.wait && !options.backgroundWorker) {
      if (options.workspace && !(await fs.stat(resolved.workspace)).isDirectory()) throw new Error(`workspace is not a directory: ${resolved.workspace}`);
      await fs.mkdir(resolved.workspace, { recursive: true });
      const { startHeadlessSubmissionWorker } = await import('./headless-worker.mjs');
      const configuredRoot = configDirectory();
      await fs.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      const workerConfigDir = await fs.realpath(configuredRoot);
      const worker = await startHeadlessSubmissionWorker({
        options: { ...options, runtime: 'local', workspace: resolved.workspace, permission: localPermission, project: taskContext.projectId || 'none' }, configDir: workerConfigDir, expectedAccountId: client.accountId, ackTimeoutMs: remaining(),
        fullAccessConfirmed,
      });
      const accepted = { platform: worker.platform, mode: worker.mode, conversationId: worker.conversationId, runId: worker.runId,
        ...(worker.goalId ? { goalId: worker.goalId } : {}),
        localMessageId: worker.localMessageId, status: worker.status, accepted: true, reply: null };
      try { await updateHeadlessState({ profile, accountId: client.accountId, currentConversationId: accepted.conversationId }); }
      catch (error) { throw acceptedLocalFailure(error, accepted); }
      return accepted;
    }
    const localTransport = resolveHeadlessLocalTransport();
    // Cross-CLI keepalive: RPC into the profile hub instead of open/close per process.
    // ws → Frontier hub (shared command websocket); sse → sticky-sandbox hub.
    if (runtimeChoice === 'local' && resolveFrontierKeepaliveEnabled()
      && !options.frontierHubServer && !options.sseHubServer
      && (options.wait || options.backgroundWorker)) {
      if (options.workspace && !(await fs.stat(resolved.workspace)).isDirectory()) {
        throw new Error(`workspace is not a directory: ${resolved.workspace}`);
      }
      await fs.mkdir(resolved.workspace, { recursive: true });
      const hubOptions = {
        ...options,
        runtime: 'local',
        workspace: resolved.workspace,
        permission: localPermission,
        project: taskContext.projectId || options.project || 'none',
        wait: true,
        backgroundWorker: true,
        // Drop non-JSON callbacks before the hub RPC boundary.
        onAccepted: undefined,
        frontierHubServer: undefined,
        sseHubServer: undefined,
      };
      if (localTransport === 'sse') {
        const { callSseHubTurn } = await import('./headless-sse-hub.mjs');
        return callSseHubTurn({
          profile,
          configDir: configDirectory(),
          options: hubOptions,
          fullAccessConfirmed,
          expectedAccountId: client.accountId,
          timeoutMs: remaining(),
          onAccepted: typeof options.onAccepted === 'function' ? options.onAccepted : undefined,
        });
      }
      if (localTransport === 'ws') {
        const { callFrontierHubTurn } = await import('./headless-frontier-hub.mjs');
        return callFrontierHubTurn({
          profile,
          configDir: configDirectory(),
          options: hubOptions,
          fullAccessConfirmed,
          expectedAccountId: client.accountId,
          timeoutMs: remaining(),
          onAccepted: typeof options.onAccepted === 'function' ? options.onAccepted : undefined,
        });
      }
    }
    let localTaskParam, localRuntime, connectors, enginePromise, localChannel, localChannelAbort, frontierSocket, frontierAgentStatus;
    let ownsFrontierSocket = true;
    try {
      if (runtimeChoice === 'local') {
        const localProject = taskContext.projectContext;
        const workspace = resolved.workspace;
        if (options.workspace && !(await fs.stat(workspace)).isDirectory()) throw new Error(`workspace is not a directory: ${workspace}`);
        await fs.mkdir(workspace, { recursive: true });
        let sandboxId = `cli-${randomUUID()}`;
        let deviceId = client.device.device_id;
        if (options.sseHubServer && localTransport === 'sse') {
          const hub = await import('./headless-sse-hub.mjs');
          const sticky = hub.getBoundHubSandboxId();
          const boundDevice = hub.getBoundHubDeviceId();
          if (!sticky) {
            throw Object.assign(new Error('SSE hub has no sticky sandbox id'), { code: 'SSE_HUB_SANDBOX_MISSING' });
          }
          sandboxId = sticky;
          if (boundDevice) deviceId = boundDevice;
        }
        const local = buildHeadlessLocalTaskParam({ workspace, sandboxId, deviceId, permission: localPermission });
        localTaskParam = JSON.parse(local.general_task_param);
        Object.assign(localTaskParam.agent_task_param, { device_name: os.hostname(), folder_name: path.basename(workspace), local_app_id: '1044603' });
        const localInput = JSON.parse(localTaskParam.task_input_json);
        localInput.project_context = localProject;
        if (!options.noSkills) localTaskParam.client_option.agent_workspace.local_skill_paths = [path.join(os.homedir(), '.agents', 'skills')];
        if (options.mcps?.length) {
          connectors = new HeadlessConnectors({ client, profile, accountId: client.accountId, requestTimeoutMs: remaining() });
          localInput.localConnectors = await connectors.snapshot(options.mcps);
        }
        localTaskParam.task_input_json = JSON.stringify(localInput);
        if (taskContext.enterpriseSkill) {
          localTaskParam.selected_skills = [taskContext.enterpriseSkill.name];
          localTaskParam.skill_selections = [{ name: taskContext.enterpriseSkill.name, skill_type: taskContext.enterpriseSkill.type, skill_id: taskContext.enterpriseSkill.externalId }];
        }
        const profileDirectory = headlessProfilePaths({ profile }).directory;
        await fs.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
        const journalDirectory = path.join(await fs.realpath(profileDirectory), 'runtime', createHash('sha256').update(client.accountId).digest('hex'));
        await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
        // Sticky SSE-hub sandboxes span conversations; journal files stay per-turn.
        const journalKey = options.sseHubServer ? `${sandboxId}.${randomUUID()}` : sandboxId;
        localRuntime = { workspace, sandboxId, deviceId, permission: localPermission,
          connectorIds: options.mcps || [], journalPath: path.join(journalDirectory, journalKey + '.json') };
      }
      const attachmentBlocks = options.attachments?.length
        ? await uploadHeadlessAttachments(client, await resolveAttachmentFiles(options.attachments), remaining()) : [];
      const body = completionBody({ conversationId, message, mode, goalId, model, reasoning, taskContext, localTaskParam, attachmentBlocks });
      // Establish the sandbox route before submit. Opening it after ACK can
      // miss the initial workspace command on a device without a native app.
      if (localRuntime) {
        localChannelAbort = new AbortController();
        if (localTransport === 'ws') {
          if (options.frontierHubServer) {
            const hub = await import('./headless-frontier-hub.mjs');
            const { attachAgentTaskStatusTracker } = await import('./headless-frontier-ws.mjs');
            frontierSocket = hub.getBoundHubFrontierSocket();
            if (!frontierSocket || typeof frontierSocket.addEventListener !== 'function') {
              throw Object.assign(new Error('Frontier hub has no open command websocket'), { code: 'FRONTIER_HUB_SOCKET_MISSING' });
            }
            // Per-turn tracker: reusing a settled tracker falsely early-completes.
            frontierAgentStatus = attachAgentTaskStatusTracker(frontierSocket);
            ownsFrontierSocket = false;
            const boundDevice = hub.getBoundHubDeviceId();
            if (boundDevice) localRuntime.deviceId = boundDevice;
          } else {
            const { connectFrontierCommandChannel } = await import('./headless-frontier-ws.mjs');
            const channel = await connectFrontierCommandChannel(client, {
              deviceId: localRuntime.deviceId, timeoutMs: Math.min(15_000, remaining()),
            });
            frontierSocket = channel.socket;
            frontierAgentStatus = channel.agentStatus;
          }
        } else {
          // Frontier probes may have registered enable_ws_multi_env=1 for this device;
          // that routes commands away from legacy SSE. Clear before subscribing.
          // SSE hub already cleared at process start; still re-assert for safety.
          const { clearMultiEnvDevice } = await import('./headless-frontier-ws.mjs');
          await clearMultiEnvDevice(client, { timeoutMs: Math.min(15_000, remaining()) }).catch(() => {});
          // Some servers flush SSE headers only after the first task command.
          // Dispatch the subscription first, but await it after acceptance.
          localChannel = prepareHeadlessLocalChannel(client, {
            sandboxId: localRuntime.sandboxId, deviceId: localRuntime.deviceId, timeoutMs: remaining(), signal: localChannelAbort.signal,
          });
          localChannel.catch(() => {});
        }
      }
      let receipt = { requestBody: body, mode, ...(localRuntime ? { localRuntime } : {}) };
      let reportedAcceptance = false;
      const startEngine = (initialResponse) => startLocalRuntime(client, profile, receipt, connectors, remaining(), initialResponse, localChannelAbort?.signal, {
        autoApprove: options.yes === true, transport: localTransport, frontierSocket,
        ownsSocket: ownsFrontierSocket,
      });
      const checkpoint = next => {
        Object.assign(receipt, next); store.save(receipt);
        if (localRuntime && options.wait && receipt.accepted && receipt.conversationId && !enginePromise) {
          if (localTransport === 'ws') {
            enginePromise = startEngine(undefined);
          } else {
            const initialResponse = localChannel;
            localChannel = null;
            enginePromise = initialResponse.then(response => startEngine(response));
          }
          enginePromise.catch(() => {});
        }
        if (receipt.accepted && !reportedAcceptance && options.onAccepted) {
          reportedAcceptance = true;
          options.onAccepted({ platform: 'headless', mode, ...(goalId ? { goalId } : {}), conversationId: receipt.conversationId, runId: receipt.runId,
            localMessageId: receipt.localMessageId, status: 'running', accepted: true, reply: null });
        }
      };
      let accepted, submissionError;
      try {
        accepted = await streamCompletion(client, body, {
          timeoutMs: remaining(), waitForReply: options.wait, onReceipt: checkpoint,
          agentStatus: localTransport === 'ws' && options.wait ? frontierAgentStatus : null,
        });
      } catch (error) {
        submissionError = error;
        if (error.result?.accepted && receipt.conversationId && receipt.runId) {
          const recoveryReceiptPath = store.filePath(receipt.conversationId, receipt.runId);
          let durableRecoveryAvailable = false;
          try {
            const saved = store.read(receipt.conversationId, receipt.runId);
            durableRecoveryAvailable = saved.conversationId === receipt.conversationId
              && saved.runId === receipt.runId && saved.accepted === true;
          } catch {}
          if (!durableRecoveryAvailable) {
            const recoveryReceipt = { ...receipt, accepted: true,
              conversationId: receipt.conversationId, runId: receipt.runId };
            error.result = { ...error.result, durableRecoveryAvailable: false, recoveryReceipt,
              recoveryReceiptPath,
              recovery: 'Restore recoveryReceipt to recoveryReceiptPath after repairing storage; do not resend' };
          }
        }
        if (enginePromise) { const engine = await enginePromise.catch(() => null); await engine?.close(); }
        await connectors?.close();
        throw error;
      }
      finally {
        if (receipt.accepted && receipt.conversationId) {
          try { await updateHeadlessState({ profile, accountId: client.accountId, currentConversationId: receipt.conversationId }); }
          catch (error) { if (!submissionError) throw acceptedLocalFailure(error, receipt); }
        }
      }
      Object.assign(receipt, accepted);
      if (!options.wait) {
        if (localRuntime) {
          localChannelAbort?.abort();
          await localChannel?.then(response => response.body?.cancel()).catch(() => {});
          localChannel = null;
          const { startHeadlessWorker } = await import('./headless-worker.mjs');
          try {
            await startHeadlessWorker({ profile, conversationId: receipt.conversationId, runId: receipt.runId, configDir: configDirectory(),
              logPath: localRuntime.journalPath + '.log' });
          } catch (error) { throw acceptedLocalFailure(error, receipt); }
        }
        await connectors?.close();
        return { platform: 'headless', mode, ...(goalId ? { goalId } : {}), conversationId: receipt.conversationId, runId: receipt.runId,
          localMessageId: receipt.localMessageId, status: 'running', accepted: true, reply: null };
      }
      try {
        // Align with Desktop MsgFinish: return on end_type=1 (or legacy settle reasons)
        // while the hub keeps draining the same SSE until end_type=3.
        if (['end_type_1', 'is_loading', 'agent_task_status'].includes(accepted.earlyComplete)
          && receipt.conversationId && receipt.runId) {
          if (localRuntime) enginePromise ||= startEngine(undefined);
          if (enginePromise) await enginePromise.catch(() => null);
          let text = String(accepted.answer || '').trim();
          const timing = process.env.DOUBAO_HEADLESS_TIMING === '1';
          const imStarted = Date.now();
          // Upgrade truncated stream answers (opening ``` only) from IM.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (text && !isIncompleteEarlyReply(text)) break;
            if (attempt) await new Promise(resolve => setTimeout(resolve, 150));
            const snapshot = await readTurn(client, receipt.conversationId, {
              runId: receipt.runId, receipt, deadline,
            }).catch(() => null);
            const im = String(snapshot?.result?.reply?.text || snapshot?.result?.progress || '').trim();
            if (im && im.length > text.length) text = im;
          }
          if (timing) {
            console.error(`[headless-timing] early_reply_resolved +${Date.now() - imStarted}ms chars=${text.length}`);
          }
          return {
            platform: 'headless', mode, ...(goalId ? { goalId } : {}),
            context: { runtime: runtimeChoice, ...(localRuntime ? { workspace: localRuntime.workspace } : {}),
              projectId: taskContext.projectId || null, enterpriseKnowledge: Boolean(taskContext.enterpriseSkill) },
            accepted: true,
            conversationId: receipt.conversationId, runId: receipt.runId, localMessageId: receipt.localMessageId,
            status: 'completed',
            reply: text ? { role: 'assistant', text } : null,
            completion: accepted.earlyComplete || 'is_loading',
          };
        }
        const wait = signal => waitTurn(client, receipt.conversationId, { runId: receipt.runId, receipt, deadline, signal,
          onReceipt: checkpoint, loadReceipt: run => store.read(receipt.conversationId, run) });
        const result = localRuntime ? await waitWithLocalRuntime(wait,
          () => enginePromise ||= startEngine(undefined),
          { abortStartup: () => localChannelAbort?.abort() }) : await wait();
        return { platform: 'headless', mode, ...(goalId ? { goalId } : {}), context: { runtime: runtimeChoice, ...(localRuntime ? { workspace: localRuntime.workspace } : {}),
          projectId: taskContext.projectId || null, enterpriseKnowledge: Boolean(taskContext.enterpriseSkill) }, accepted: true, ...result };
      } catch (error) { throw acceptedLocalFailure(error, receipt); }
    } finally {
      localChannelAbort?.abort();
      await localChannel?.then(response => response.body?.cancel()).catch(() => {});
      try { frontierAgentStatus?.detach?.(); } catch {}
      if (ownsFrontierSocket) {
        try { frontierSocket?.close?.(); } catch {}
      }
      // Local tool frames can still arrive after REPLYING clears; don't block the
      // user-visible completion on draining the Frontier loop.
      if (enginePromise) {
        const engine = await enginePromise.catch(() => null);
        if (engine) {
          const closing = engine.close().catch(() => {});
          await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 800))]);
        }
      }
      await connectors?.close();
    }
  }
  const conversationId = validateId(operand);
  const pinned = await readTurn(client, conversationId, { runId: options.runId, deadline });
  const receipt = { ...store.read(conversationId, pinned.result.runId), conversationId, runId: pinned.result.runId };
  let connectors;
  const needsRuntime = subcommand === 'wait' && receipt.localRuntime && !['completed', 'failed', 'cancelled'].includes(pinned.result.status);
  const runtimeAbort = new AbortController();
  if (needsRuntime) {
    if (resolvePermission(receipt.localRuntime.permission ?? DEFAULT_HEADLESS_PERMISSION) === 2) {
      await authorizeFullAccess(receipt.localRuntime.workspace);
    }
    if (receipt.localRuntime.connectorIds?.length) connectors = new HeadlessConnectors({ client, profile, accountId: client.accountId, requestTimeoutMs: remaining() });
  }
  const operation = subcommand === 'wait' ? waitTurn : subcommand === 'stop' ? stopTurn : refreshTurn;
  try {
    const wait = signal => operation(client, conversationId, { runId: receipt.runId, receipt, deadline, timeoutMs: remaining(), signal,
      onReceipt: next => store.save(next), loadReceipt: run => store.read(conversationId, run) });
    const result = needsRuntime ? await waitWithLocalRuntime(wait,
      () => startLocalRuntime(client, profile, receipt, connectors, remaining(), undefined, runtimeAbort.signal, { autoApprove: options.yes === true }),
      { abortStartup: () => runtimeAbort.abort() }) : await wait();
    return { platform: 'headless', ...(result.result || result) };
  } finally { runtimeAbort.abort(); await connectors?.close(); }
}

function acceptedLocalFailure(error, receipt) {
  error.result ??= { platform: 'headless', conversationId: receipt.conversationId, runId: receipt.runId,
    localMessageId: receipt.localMessageId, accepted: true, status: 'unknown', reply: null,
    recovery: 'The request was accepted; repair local state and use sessions wait with the same IDs; do not resend' };
  return error;
}

async function startLocalRuntime(client, profile, receipt, connectors, timeoutMs, initialResponse, signal, {
  autoApprove = false, transport = 'sse', frontierSocket = null, ownsSocket = true,
} = {}) {
  const spec = receipt.localRuntime;
  // Memory-only authentication creates fresh device metadata per CLI process.
  // A resumed local task must retain the original caller's routing device.
  client.device = { ...client.device, device_id: spec.deviceId };
  const approve = autoApprove === true
    ? async request => !(request?.signal?.aborted)
    : createHeadlessApproval({ input: process.stdin, output: process.stderr,
      interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY), workspace: spec.workspace });
  const engine = new HeadlessLocalRuntime({ client, ...spec, accountId: client.accountId, conversationId: receipt.conversationId,
    requestTimeoutMs: timeoutMs, initialResponse, callConnector: connectors ? input => connectors.call(input) : undefined,
    approve, transport, frontierSocket, ownsSocket });
  try { await engine.start({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]) : AbortSignal.timeout(Math.max(1, timeoutMs)) }); return engine; }
  catch (error) { await engine.close(); if (error.code === 'LOCAL_RUNTIME_BUSY') return null; throw error; }
}

// Filled from the server's live catalog; no hard-coded model aliases or entitlements.
async function headlessModels(client, timeoutMs) {
  const result = await client.json('/alice/slot/action_bar_v3/brief_list', { method: 'POST', timeoutMs,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language_code: 'zh', bot_id: '7338286299411103781' }) });
  if (result.code !== 0) throw new Error('Doubao model catalog request was rejected');
  const config = result.data?.entry_list?.find(entry => entry.action_bar_key === 'coco_deep_thinking')?.active_switch_conf;
  if (!config) throw new Error('This account has no headless model catalog');
  const v2 = config.menu_conf_v2;
  const modes = v2?.mode_list?.item_list || [];
  const models = new Map();
  const add = (item, mode) => {
    const id = String(item.model_item_key || item.item_id || '');
    if (!id || !item.name) return;
    const previous = models.get(id);
    const enabled = !item.disabled && item.subscribe_config?.need_upgrade !== true;
    models.set(id, { id, name: item.name, provider: item.model_extra_params?.provider_id || '',
      needDeepThink: item.model_extra_params?.model_type === 'custom' ? 10001 : /^\d+$/u.test(id) ? Number(id) : Number(item.item_id),
      available: enabled, modes: [...new Set([...(previous?.modes || []), mode].filter(Boolean))] });
  };
  for (const mode of modes) {
    const label = mode.agent_mode === 1 ? 'work' : mode.agent_mode === 2 ? 'chat' : undefined;
    for (const item of mode.model_list?.item_list || []) add(item, label);
    for (const item of v2?.model_list?.item_list || []) {
      if (!mode.support_models?.length || mode.support_models.some(model => String(model.model_item_key || model.item_id || model) === String(item.model_item_key || item.item_id))) add(item, label);
    }
  }
  if (!models.size) for (const item of config.menu_conf?.item_list || []) add(item, item.agent_mode === 1 ? 'work' : 'chat');
  if (!models.size) throw new Error('Doubao model catalog is empty');
  return { platform: 'headless', models: [...models.values()] };
}
async function resolveHeadlessModel(client, selection, mode, timeoutMs) {
  const catalog = await headlessModels(client, timeoutMs);
  const name = selection.name === undefined ? null : resolveModelName(selection.name, catalog.models.map(model => model.name));
  const matches = catalog.models.filter(model => (selection.id === undefined ? model.name === name : model.id === selection.id)
    && model.available && (!mode || model.modes.includes(mode)));
  if (matches.length !== 1) throw new Error('Select an available headless model by its exact name');
  return matches[0];
}
function parseExtra(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
function reasoningName(value) {
  return ({ '3': 'low', '4': 'medium', '5': 'high', '6': 'xhigh', '7': 'max' })[String(value)] || null;
}
