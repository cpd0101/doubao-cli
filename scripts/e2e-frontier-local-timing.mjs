#!/usr/bin/env node
/**
 * Compare Headless local end-to-end latency: SSE vs Frontier command WS.
 * Uses distinct prompts per transport/turn so server-side queries are identifiable,
 * and measures both first-turn create and second-turn send.
 *
 *   node scripts/e2e-frontier-local-timing.mjs
 *   node scripts/e2e-frontier-local-timing.mjs --write
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doubaoBin = process.env.DOUBAO_BIN || path.join(root, 'bin/doubao.mjs');
const wantWrite = process.argv.includes('--write');
const stamp = Date.now();

/** Distinct prompts so SSE vs Frontier (and turn1 vs turn2) can be told apart in logs/receipts. */
function promptsFor(transport) {
  const tag = transport === 'frontier' ? 'FRONTIER_WS' : 'HTTP_SSE';
  if (wantWrite) {
    return {
      turn1: `[${tag}][T1][${stamp}] Write ${transport}-t1.txt containing ${transport}-t1 and reply DONE-${tag}-T1 only.`,
      turn2: `[${tag}][T2][${stamp}] Write ${transport}-t2.txt containing ${transport}-t2 and reply DONE-${tag}-T2 only.`,
      expect1: `DONE-${tag}-T1`,
      expect2: `DONE-${tag}-T2`,
      file1: `${transport}-t1.txt`,
      file2: `${transport}-t2.txt`,
    };
  }
  return {
    turn1: `[${tag}][T1][${stamp}] Reply with exactly PONG-${tag}-T1 and nothing else.`,
    turn2: `[${tag}][T2][${stamp}] Reply with exactly PONG-${tag}-T2 and nothing else.`,
    expect1: `PONG-${tag}-T1`,
    expect2: `PONG-${tag}-T2`,
    file1: null,
    file2: null,
  };
}

function runDoubao(args, env = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [doubaoBin, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
  });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  return new Promise((resolve) => {
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      resolve({
        ms: Date.now() - started,
        code,
        status: parsed?.status || null,
        reply: parsed?.reply?.text || null,
        conversationId: parsed?.conversationId || null,
        runId: parsed?.runId || null,
        completion: parsed?.completion || null,
        err: err.slice(0, 400),
        outHead: out.slice(0, 240),
        parsed,
      });
    });
  });
}

async function runTransport(label) {
  const transport = label === 'frontier' ? 'frontier' : 'sse';
  // Default CLI transport is frontier-ws; force http-sse explicitly for the SSE arm.
  const env = {
    DOUBAO_HEADLESS_LOCAL_TRANSPORT: transport === 'frontier' ? 'frontier-ws' : 'http-sse',
  };
  const prompts = promptsFor(transport);
  const workspace = mkdtempSync(path.join(os.tmpdir(), `doubao-${label}-`));

  console.log(`${label} turn1 create...`);
  const turn1 = await runDoubao([
    '--platform', 'headless', '--mode', 'work', 'sessions', 'create', prompts.turn1,
    '--runtime', 'local', '--workspace', workspace, '--permission', 'FullAccess',
    '--yes', '--wait', '--timeout', '180', '--json',
  ], env);
  console.log({
    label, turn: 1, ms: turn1.ms, status: turn1.status, reply: turn1.reply?.slice(0, 80),
    conversationId: turn1.conversationId, completion: turn1.completion,
  });

  let turn2 = null;
  if (turn1.code === 0 && turn1.status === 'completed' && turn1.conversationId) {
    console.log(`${label} turn2 send...`);
    turn2 = await runDoubao([
      '--platform', 'headless', 'sessions', 'send', turn1.conversationId, prompts.turn2,
      '--runtime', 'local', '--workspace', workspace, '--permission', 'FullAccess',
      '--yes', '--wait', '--timeout', '180', '--json',
    ], env);
    console.log({
      label, turn: 2, ms: turn2.ms, status: turn2.status, reply: turn2.reply?.slice(0, 80),
      conversationId: turn2.conversationId || turn1.conversationId, completion: turn2.completion,
    });
  }

  const files = [];
  try {
    for (const name of [prompts.file1, prompts.file2].filter(Boolean)) {
      const target = path.join(workspace, name);
      files.push({ name, exists: existsSync(target), text: existsSync(target) ? readFileSync(target, 'utf8') : null });
    }
  } catch {}

  const turn1Ok = turn1.code === 0 && turn1.status === 'completed'
    && (!prompts.expect1 || String(turn1.reply || '').includes(prompts.expect1));
  const turn2Ok = Boolean(turn2)
    && turn2.code === 0 && turn2.status === 'completed'
    && (!prompts.expect2 || String(turn2.reply || '').includes(prompts.expect2));

  return {
    label,
    transport: transport === 'frontier' ? 'frontier-ws' : 'http-sse',
    prompts,
    workspace,
    turn1: { ...turn1, ok: turn1Ok },
    turn2: turn2 ? { ...turn2, ok: turn2Ok } : null,
    files,
    ok: turn1Ok && turn2Ok,
    totalMs: turn1.ms + (turn2?.ms || 0),
  };
}

const results = [];
results.push(await runTransport('sse'));
results.push(await runTransport('frontier'));

const sse = results.find((row) => row.label === 'sse');
const frontier = results.find((row) => row.label === 'frontier');
const summary = {
  stamp,
  mode: wantWrite ? 'write' : 'pong',
  sse: {
    turn1Ms: sse?.turn1?.ms, turn2Ms: sse?.turn2?.ms, totalMs: sse?.totalMs,
    turn1Reply: sse?.turn1?.reply, turn2Reply: sse?.turn2?.reply,
    ok: sse?.ok, prompts: sse?.prompts,
  },
  frontier: {
    turn1Ms: frontier?.turn1?.ms, turn2Ms: frontier?.turn2?.ms, totalMs: frontier?.totalMs,
    turn1Reply: frontier?.turn1?.reply, turn2Reply: frontier?.turn2?.reply,
    turn1Completion: frontier?.turn1?.completion, turn2Completion: frontier?.turn2?.completion,
    ok: frontier?.ok, prompts: frontier?.prompts,
  },
  delta: {
    turn1Ms: (sse?.turn1 && frontier?.turn1) ? frontier.turn1.ms - sse.turn1.ms : null,
    turn2Ms: (sse?.turn2 && frontier?.turn2) ? frontier.turn2.ms - sse.turn2.ms : null,
    totalMs: (sse && frontier) ? frontier.totalMs - sse.totalMs : null,
  },
  results,
};
const outPath = path.join(os.tmpdir(), `doubao-frontier-timing-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  stamp: summary.stamp,
  mode: summary.mode,
  sse: summary.sse,
  frontier: summary.frontier,
  delta: summary.delta,
}, null, 2));
console.log('wrote', outPath);
process.exit(summary.sse.ok && summary.frontier.ok ? 0 : 1);
