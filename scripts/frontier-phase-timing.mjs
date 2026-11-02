#!/usr/bin/env node
/**
 * Break down Frontier WS wall time into phases for one local write turn.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HeadlessClient } from '../src/headless-http.mjs';
import {
  connectFrontierCommandChannel, extractDispatchPayloads, summarizeDispatchPayload,
} from '../src/headless-frontier-ws.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const session = JSON.parse(readFileSync(path.join(
  os.homedir(), 'Library/Application Support/doubao-cli/headless/session.json'), 'utf8'));
const client = new HeadlessClient({
  cookies: session.cookies, device: session.device, accountId: session.accountId,
});

const marks = [];
const mark = (name, extra = {}) => {
  const row = { t: Date.now(), name, ...extra };
  marks.push(row);
  console.log(JSON.stringify(row));
};

const t0 = Date.now();
mark('start');
const channel = await connectFrontierCommandChannel(client, {
  deviceId: String(client.device.device_id), timeoutMs: 15_000,
});
mark('frontier_open');

const frames = [];
channel.socket.addEventListener('message', async (event) => {
  const buffer = Buffer.from(await event.data.arrayBuffer());
  for (const payload of extractDispatchPayloads(buffer)) {
    const summary = summarizeDispatchPayload(payload);
    frames.push({ ms: Date.now() - t0, ...summary });
    mark('frame', summary);
  }
});

const workspace = mkdtempSync(path.join(os.tmpdir(), 'doubao-frontier-phase-'));
const child = spawn(process.execPath, [
  path.join(root, 'bin/doubao.mjs'),
  '--platform', 'headless', '--mode', 'work', 'sessions', 'create',
  'Write phase.txt containing ok and reply DONE only.',
  '--runtime', 'local', '--workspace', workspace, '--permission', 'FullAccess',
  '--yes', '--wait', '--timeout', '180', '--json',
], {
  env: { ...process.env, DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'frontier-ws' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { err += c; });
const code = await new Promise((resolve) => child.on('close', resolve));
mark('process_exit', { code });
try { channel.socket.close?.(); } catch {}

let parsed = null;
try { parsed = JSON.parse(out); } catch {}
const summary = {
  totalMs: Date.now() - t0,
  code,
  status: parsed?.status,
  reply: parsed?.reply?.text || null,
  conversationId: parsed?.conversationId,
  workspace,
  phases: marks.map((row, i) => ({
    name: row.name,
    ms: row.t - t0,
    deltaMs: i ? row.t - marks[i - 1].t : 0,
    ...(row.name ? {} : {}),
    ...Object.fromEntries(Object.entries(row).filter(([k]) => !['t', 'name'].includes(k))),
  })),
  frames,
  err: err.slice(0, 300),
};
const outPath = path.join(os.tmpdir(), `doubao-frontier-phase-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ outPath, totalMs: summary.totalMs, status: summary.status, nFrames: frames.length, phases: summary.phases.filter(p => p.name !== 'frame' || p.command) }, null, 2));
process.exit(code === 0 && summary.status === 'completed' ? 0 : 1);
