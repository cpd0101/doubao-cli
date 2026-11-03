#!/usr/bin/env node
/**
 * Same-process Frontier warm probe (fixed):
 * - keep: one command WS across turns
 * - reconnect: new WS each turn
 * Per-turn fresh agent_task_status tracker (avoids "already settled" false early-complete).
 * first_frame only counts tools for THIS turn's sandbox_id after submit.
 *
 *   node scripts/probe-frontier-warm.mjs --turns 6 --mode keep
 *   node scripts/probe-frontier-warm.mjs --turns 6 --mode reconnect
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HeadlessClient } from '../src/headless-http.mjs';
import { completionBody } from '../src/headless-completion.mjs';
import { streamCompletion } from '../src/headless.mjs';
import { HeadlessLocalRuntime, buildHeadlessLocalTaskParam } from '../src/headless-local-runtime.mjs';
import {
  connectFrontierCommandChannel, attachAgentTaskStatusTracker,
  extractDispatchPayloads, dispatchPayloadToLocalFrame,
} from '../src/headless-frontier-ws.mjs';

process.env.DOUBAO_HEADLESS_TIMING = '1';

const turns = Number(process.argv.includes('--turns')
  ? process.argv[process.argv.indexOf('--turns') + 1] : 6);
const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1] : 'keep';
const turnTimeoutMs = Number(process.argv.includes('--timeout-ms')
  ? process.argv[process.argv.indexOf('--timeout-ms') + 1] : 90_000);

const session = JSON.parse(readFileSync(path.join(
  os.homedir(), 'Library/Application Support/doubao-cli/headless/session.json'), 'utf8'));
const client = new HeadlessClient({
  cookies: session.cookies, device: session.device, accountId: session.accountId,
});
await client.account({ timeoutMs: 15_000 });

const workspace = mkdtempSync(path.join(os.tmpdir(), 'doubao-warm-'));
const deviceId = String(client.device.device_id);
const results = [];
let conversationId = '';
let channel = null;
let statusTracker = null;

async function openChannel() {
  const next = await connectFrontierCommandChannel(client, {
    deviceId, timeoutMs: 15_000, reportDevice: true, trackAgentStatus: false,
  });
  if (mode === 'keep') {
    next._realClose = next.socket.close?.bind(next.socket);
    next.socket.close = () => {};
  }
  return next;
}

async function closeChannel() {
  try { statusTracker?.detach?.(); } catch {}
  statusTracker = null;
  if (!channel) return;
  try {
    if (channel._realClose) channel._realClose();
    else channel.socket.close?.();
  } catch {}
  channel = null;
}

function armStatusTracker() {
  try { statusTracker?.detach?.(); } catch {}
  statusTracker = attachAgentTaskStatusTracker(channel.socket);
  return statusTracker;
}

async function runTurn(index) {
  const turnStarted = Date.now();
  let runtime = null;
  const engineAbort = new AbortController();
  try {
    if (mode === 'reconnect' || !channel) {
      await closeChannel();
      channel = await openChannel();
      console.log(JSON.stringify({ phase: 'channel_open', index, mode }));
    }

    const sandboxId = `cli-${randomUUID()}`;
    const bootstrapConversationId = conversationId || '1000000000000001';
    const local = buildHeadlessLocalTaskParam({
      workspace, sandboxId, deviceId, permission: 'FullAccess',
    });
    const localTaskParam = JSON.parse(local.general_task_param);
    Object.assign(localTaskParam.agent_task_param, {
      device_name: os.hostname(),
      folder_name: path.basename(workspace),
      local_app_id: '1044603',
    });
    localTaskParam.client_option.agent_workspace.local_skill_paths = [
      path.join(os.homedir(), '.agents', 'skills'),
    ];

    const agentStatus = armStatusTracker();

    runtime = new HeadlessLocalRuntime({
      client, workspace, sandboxId, deviceId,
      conversationId: bootstrapConversationId,
      permission: 'FullAccess',
      transport: 'frontier-ws',
      frontierSocket: channel.socket,
      approve: async () => true,
      onError: (error) => {
        console.error(`[warm-probe] runtime error: ${error?.message || error}`);
      },
    });

    await Promise.race([
      runtime.start({
        signal: AbortSignal.any([engineAbort.signal, AbortSignal.timeout(turnTimeoutMs)]),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('runtime ready timeout')), 10_000)),
    ]);
    console.log(JSON.stringify({ phase: 'runtime_ready', index }));

    let submitAt = 0;
    let firstAfterSubmitMs = null;
    let firstAfterSubmitName = null;
    const onProbeMessage = async (event) => {
      if (!submitAt || firstAfterSubmitMs != null) return;
      try {
        const raw = event.data;
        const buffer = Buffer.isBuffer(raw) ? raw
          : raw instanceof ArrayBuffer ? Buffer.from(raw)
          : typeof Blob !== 'undefined' && raw instanceof Blob ? Buffer.from(await raw.arrayBuffer())
          : Buffer.from(String(raw ?? ''), 'utf8');
        for (const payload of extractDispatchPayloads(buffer)) {
          const frame = dispatchPayloadToLocalFrame(payload);
          if (!frame) continue;
          if (frame.sandbox_id && frame.sandbox_id !== sandboxId) continue;
          const call = frame.tool_call || frame.command || {};
          firstAfterSubmitMs = Date.now() - submitAt;
          firstAfterSubmitName = call.name || '?';
          break;
        }
      } catch {}
    };
    channel.socket.addEventListener('message', onProbeMessage);

    const message = `[WARM][${index}][${Date.now()}] Write warm-${index}.txt containing WARM-${index} and reply DONE-WARM-${index} only.`;
    const body = completionBody({
      conversationId, message, mode: 'work', localTaskParam,
    });

    submitAt = Date.now();
    let state;
    try {
      state = await streamCompletion(client, body, {
        timeoutMs: turnTimeoutMs,
        waitForReply: true,
        agentStatus,
        onReceipt: (next) => {
          if (next.conversationId) runtime.conversationId = next.conversationId;
        },
      });
    } finally {
      channel.socket.removeEventListener('message', onProbeMessage);
    }

    conversationId = state.conversationId || conversationId;
    let file = null;
    try { file = readFileSync(path.join(workspace, `warm-${index}.txt`), 'utf8'); } catch {}
    const reply = String(state.answer || '').trim();
    const row = {
      index, mode, deviceId, conversationId, sandboxId,
      wallMs: Date.now() - turnStarted,
      status: (state.earlyComplete || state.completed) && (reply || file) ? 'completed'
        : (state.earlyComplete || state.completed) ? 'empty' : 'unknown',
      reply: reply.slice(0, 48),
      firstFrameMs: firstAfterSubmitMs,
      firstName: firstAfterSubmitName,
      earlyComplete: state.earlyComplete || null,
      file,
    };
    results.push(row);
    console.log(JSON.stringify({ phase: 'turn', ...row }));
    return row;
  } finally {
    engineAbort.abort();
    try { await runtime?.close?.(); } catch {}
  }
}

console.log(JSON.stringify({
  phase: 'start', mode, turns, turnTimeoutMs, deviceId, workspace, accountId: client.accountId,
}));

try {
  channel = await openChannel();
  console.log(JSON.stringify({ phase: 'frontier_ready', mode }));
  await new Promise((r) => setTimeout(r, 1000));

  for (let i = 1; i <= turns; i += 1) {
    try {
      await runTurn(i);
    } catch (error) {
      const row = {
        index: i, mode, deviceId, conversationId,
        wallMs: null, status: 'error', reply: null,
        firstFrameMs: null, firstName: null, file: null,
        error: String(error?.message || error).slice(0, 240),
      };
      results.push(row);
      console.log(JSON.stringify({ phase: 'turn_error', ...row }));
      await closeChannel();
      channel = await openChannel();
    }
    await new Promise((r) => setTimeout(r, 400));
  }
} finally {
  await closeChannel();
}

const ffs = results.map((r) => r.firstFrameMs).filter((n) => Number.isFinite(n));
const ok = results.filter((r) => r.status === 'completed');
const summary = {
  phase: 'summary',
  mode,
  deviceId,
  turns: results.length,
  completed: ok.length,
  firstFrames: ffs,
  min: ffs.length ? Math.min(...ffs) : null,
  max: ffs.length ? Math.max(...ffs) : null,
  median: ffs.length ? [...ffs].sort((a, b) => a - b)[Math.floor(ffs.length / 2)] : null,
  fastCount: ffs.filter((n) => n < 5_000).length,
  slowCount: ffs.filter((n) => n > 15_000).length,
  results,
};
const outPath = path.join(os.tmpdir(), `doubao-frontier-warm-${mode}-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  phase: 'summary', mode, deviceId,
  turns: summary.turns, completed: summary.completed,
  firstFrames: summary.firstFrames,
  min: summary.min, max: summary.max, median: summary.median,
  fastCount: summary.fastCount, slowCount: summary.slowCount,
  outPath, workspace,
}, null, 2));
