#!/usr/bin/env node
/**
 * Experimental probe: register Headless for multi_env, open Frontier command WS,
 * and print redacted DispatchCommandPayload summaries while a local send runs.
 *
 * Usage:
 *   node scripts/probe-frontier-command-ws.mjs [--send]
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HeadlessClient } from '../src/headless-http.mjs';
import {
  buildFrontierWsUrl, extractDispatchPayloads, fetchLaunchConfig, openFrontierSocket,
  reportMultiEnvDevice, summarizeDispatchPayload,
} from '../src/headless-frontier-ws.mjs';

const sessionPath = path.join(
  process.env.HOME || os.homedir(),
  'Library/Application Support/doubao-cli/headless/session.json',
);
const doSend = process.argv.includes('--send');

const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
const client = new HeadlessClient({
  cookies: session.cookies, device: session.device, accountId: session.accountId,
});

const report = await reportMultiEnvDevice(client);
console.log('report_device', { code: report?.code, msg: report?.msg || report?.message });

const config = await fetchLaunchConfig(client);
const cookie = client.jar.header(new URL('https://www.doubao.com/'));
const url = buildFrontierWsUrl(config, { deviceId: client.device.device_id });
const sock = openFrontierSocket(url, { cookie });

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Frontier WS open timeout')), 10_000);
  sock.addEventListener('open', () => { clearTimeout(timer); resolve(); });
  sock.addEventListener('error', (error) => { clearTimeout(timer); reject(error); });
});
console.log('frontier open', {
  fpid: config.ws_product_id, aid: config.ws_app_id, deviceId: client.device.device_id,
});

const seen = [];
sock.addEventListener('message', async (event) => {
  const buffer = Buffer.from(await event.data.arrayBuffer());
  for (const payload of extractDispatchPayloads(buffer)) {
    const summary = summarizeDispatchPayload(payload);
    seen.push(summary);
    console.log('dispatch', summary);
  }
});

if (doSend) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'doubao-frontier-probe-'));
  console.log('sending headless local', workspace);
  const child = spawn('doubao', [
    '--platform', 'headless', '--mode', 'work', 'sessions', 'create', 'Say only HI.',
    '--runtime', 'local', '--workspace', workspace, '--permission', 'FullAccess',
    '--yes', '--wait', '--timeout', '120', '--json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log('send_exit', code);
  console.log('send_out', out.slice(0, 400));
} else {
  console.log('listening 20s (pass --send to drive a headless local create)');
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}

console.log('dispatch_count', seen.length);
try { sock.close(); } catch {}
