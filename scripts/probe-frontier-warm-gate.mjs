#!/usr/bin/env node
/**
 * Gate whether Frontier keep-alive (not cloud luck) explains ~10s CDP-like turns.
 *
 * Protocol:
 *   A) cold CLI xN          — fresh process each time, no shared WS
 *   B) keep WS + idle + xN  — one WS held across idle then turns
 *   C) disconnect + idle + cold CLI xN
 *
 * If B is fast while A/C are slow → keep-alive is causal.
 * If A/B/C move together → cloud window, not keep-alive.
 *
 *   node scripts/probe-frontier-warm-gate.mjs
 *   node scripts/probe-frontier-warm-gate.mjs --rounds 3 --idle-ms 120000
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doubaoBin = path.join(root, 'bin/doubao.mjs');
const rounds = Number(process.argv.includes('--rounds')
  ? process.argv[process.argv.indexOf('--rounds') + 1] : 3);
const idleMs = Number(process.argv.includes('--idle-ms')
  ? process.argv[process.argv.indexOf('--idle-ms') + 1] : 180_000);
const turnTimeoutMs = 90_000;
const FAST = 5_000;
const SLOW = 15_000;

const session = JSON.parse(readFileSync(path.join(
  os.homedir(), 'Library/Application Support/doubao-cli/headless/session.json'), 'utf8'));
const client = new HeadlessClient({
  cookies: session.cookies, device: session.device, accountId: session.accountId,
});
await client.account({ timeoutMs: 15_000 });
const deviceId = String(client.device.device_id);
const stamp = Date.now();
const outDir = mkdtempSync(path.join(os.tmpdir(), 'doubao-warm-gate-'));
const results = [];

function classify(ff) {
  if (!Number.isFinite(ff)) return 'na';
  if (ff < FAST) return 'fast';
  if (ff > SLOW) return 'slow';
  return 'mid';
}

function summarize(label, rows) {
  const ffs = rows.map((r) => r.firstFrameMs).filter((n) => Number.isFinite(n));
  return {
    label,
    n: rows.length,
    firstFrames: ffs,
    min: ffs.length ? Math.min(...ffs) : null,
    max: ffs.length ? Math.max(...ffs) : null,
    median: ffs.length ? [...ffs].sort((a, b) => a - b)[Math.floor(ffs.length / 2)] : null,
    fast: ffs.filter((n) => n < FAST).length,
    slow: ffs.filter((n) => n > SLOW).length,
    completed: rows.filter((r) => r.status === 'completed').length,
  };
}

function runColdCli(index, phase) {
  const workspace = mkdtempSync(path.join(outDir, `cold-${phase}-${index}-`));
  const started = Date.now();
  const prompt = `[GATE][COLD][${phase}][${index}][${stamp}] Write cold-${phase}-${index}.txt containing COLD-${phase}-${index} and reply DONE-COLD-${phase}-${index} only.`;
  const child = spawn(process.execPath, [
    doubaoBin,
    '--platform', 'headless', '--mode', 'work', 'sessions', 'create', prompt,
    '--runtime', 'local', '--workspace', workspace,
    '--permission', 'FullAccess', '--yes', '--wait',
    '--timeout', String(Math.ceil(turnTimeoutMs / 1000)), '--json',
  ], {
    env: { ...process.env, DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'frontier-ws', DOUBAO_HEADLESS_TIMING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
  });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), turnTimeoutMs + 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      const ff = err.match(/first_frame \+(\d+)ms name=(\S+)/);
      const early = err.match(/completion_early_complete \+(\d+)ms/);
      const filePath = path.join(workspace, `cold-${phase}-${index}.txt`);
      const row = {
        phase, arm: 'cold_cli', index, deviceId,
        wallMs: Date.now() - started,
        code,
        status: parsed?.status || (code === 0 ? 'unknown' : 'error'),
        reply: String(parsed?.reply?.text || parsed?.reply || '').slice(0, 40),
        firstFrameMs: ff ? Number(ff[1]) : null,
        firstName: ff?.[2] || null,
        earlyMs: early ? Number(early[1]) : null,
        class: classify(ff ? Number(ff[1]) : null),
        file: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
        conversationId: parsed?.conversationId || null,
      };
      results.push(row);
      console.log(JSON.stringify({ phase: 'row', ...row }));
      resolve(row);
    });
  });
}

async function runKeepBlock(phase, idleBeforeMs) {
  const workspace = mkdtempSync(path.join(outDir, `keep-${phase}-`));
  let conversationId = '';
  const channel = await connectFrontierCommandChannel(client, {
    deviceId, timeoutMs: 15_000, reportDevice: true, trackAgentStatus: false,
  });
  const realClose = channel.socket.close?.bind(channel.socket);
  channel.socket.close = () => {};
  console.log(JSON.stringify({ phase: 'keep_open', arm: 'keep', idleBeforeMs }));

  if (idleBeforeMs > 0) {
    console.log(JSON.stringify({ phase: 'idle_start', arm: 'keep', ms: idleBeforeMs }));
    await new Promise((r) => setTimeout(r, idleBeforeMs));
    console.log(JSON.stringify({ phase: 'idle_end', arm: 'keep' }));
  }

  try {
    for (let index = 1; index <= rounds; index += 1) {
      const started = Date.now();
      const sandboxId = `cli-${randomUUID()}`;
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

      const agentStatus = attachAgentTaskStatusTracker(channel.socket);
      const runtime = new HeadlessLocalRuntime({
        client, workspace, sandboxId, deviceId,
        conversationId: conversationId || '1000000000000001',
        permission: 'FullAccess',
        transport: 'frontier-ws',
        frontierSocket: channel.socket,
        approve: async () => true,
      });
      const engineAbort = new AbortController();
      try {
        await Promise.race([
          runtime.start({
            signal: AbortSignal.any([engineAbort.signal, AbortSignal.timeout(turnTimeoutMs)]),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('runtime ready timeout')), 10_000)),
        ]);

        let submitAt = 0;
        let firstAfterSubmitMs = null;
        let firstAfterSubmitName = null;
        const onMsg = async (event) => {
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
        channel.socket.addEventListener('message', onMsg);

        const message = `[GATE][KEEP][${phase}][${index}][${stamp}] Write keep-${phase}-${index}.txt containing KEEP-${phase}-${index} and reply DONE-KEEP-${phase}-${index} only.`;
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
          channel.socket.removeEventListener('message', onMsg);
          try { agentStatus.detach?.(); } catch {}
        }

        conversationId = state.conversationId || conversationId;
        const filePath = path.join(workspace, `keep-${phase}-${index}.txt`);
        const reply = String(state.answer || '').trim();
        const row = {
          phase, arm: 'keep', index, deviceId, conversationId,
          wallMs: Date.now() - started,
          status: (state.earlyComplete || state.completed) && (reply || existsSync(filePath)) ? 'completed' : 'empty',
          reply: reply.slice(0, 40),
          firstFrameMs: firstAfterSubmitMs,
          firstName: firstAfterSubmitName,
          class: classify(firstAfterSubmitMs),
          file: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
        };
        results.push(row);
        console.log(JSON.stringify({ phase: 'row', ...row }));
      } finally {
        engineAbort.abort();
        try { await runtime.close(); } catch {}
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    try { realClose?.(); } catch {}
  }
}

function verdict(a, b, c) {
  const mostlySlow = (s) => s.n > 0 && s.slow >= Math.ceil(s.n / 2);
  const mostlyFast = (s) => s.n > 0 && s.fast >= Math.ceil(s.n / 2);
  if (mostlySlow(a) && mostlyFast(b) && mostlySlow(c)) {
    return {
      causal: true,
      reason: 'cold slow, keep-after-idle fast, cold-after-disconnect slow → keep-alive explains CDP-like speed',
    };
  }
  if (mostlyFast(a) && mostlyFast(b) && mostlyFast(c)) {
    return {
      causal: false,
      reason: 'all arms fast → currently in cloud fast window; keep-alive not isolated',
    };
  }
  if (mostlySlow(a) && mostlySlow(b) && mostlySlow(c)) {
    return {
      causal: false,
      reason: 'all arms slow → keep-alive does not rescue CDP-like speed in this window',
    };
  }
  return {
    causal: null,
    reason: 'mixed results; keep-alive not cleanly isolated as the cause',
  };
}

console.log(JSON.stringify({
  phase: 'start', rounds, idleMs, deviceId, outDir, accountId: client.accountId,
}));

console.log(JSON.stringify({ phase: 'block', name: 'A_cold' }));
for (let i = 1; i <= rounds; i += 1) await runColdCli(i, 'A');

console.log(JSON.stringify({ phase: 'block', name: 'B_keep_after_idle' }));
await runKeepBlock('B', idleMs);

console.log(JSON.stringify({ phase: 'block', name: 'C_cold_after_disconnect_idle' }));
console.log(JSON.stringify({ phase: 'idle_start', arm: 'disconnect', ms: idleMs }));
await new Promise((r) => setTimeout(r, idleMs));
console.log(JSON.stringify({ phase: 'idle_end', arm: 'disconnect' }));
for (let i = 1; i <= rounds; i += 1) await runColdCli(i, 'C');

const A = summarize('A_cold', results.filter((r) => r.phase === 'A'));
const B = summarize('B_keep_after_idle', results.filter((r) => r.phase === 'B'));
const C = summarize('C_cold_after_disconnect_idle', results.filter((r) => r.phase === 'C'));
const gate = verdict(A, B, C);
const summary = { phase: 'summary', deviceId, idleMs, rounds, A, B, C, gate, results };
const outPath = path.join(outDir, `gate-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ phase: 'summary', A, B, C, gate, outPath, outDir }, null, 2));
process.exit(0);
