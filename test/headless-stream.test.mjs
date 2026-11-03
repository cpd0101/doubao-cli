import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionBody, isIncompleteEarlyReply, resolveFrontierKeepaliveEnabled,
  resolveHeadlessLocalTransport, streamCompletion,
} from '../src/headless.mjs';

const conversationId = '38439138239851266', runId = '38439138239851267';
const ack = { ack_client_meta: { conversation_id: conversationId }, query_list: [{ question_id: runId }] };
const response = () => new Response(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });

test('accepted IDs survive a receipt persistence failure without a second dispatch', async () => {
  let requests = 0;
  await assert.rejects(streamCompletion({ request: async () => { requests++; return response(); } },
    completionBody({ message: 'fixture', mode: 'chat' }), {
      timeoutMs: 1000, onReceipt() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    }), error => {
    assert.equal(error.code, 'ENOSPC');
    assert.equal(error.result.accepted, true);
    assert.equal(error.result.conversationId, conversationId);
    assert.equal(error.result.runId, runId);
    assert.match(error.result.recovery, /do not resend/u);
    return true;
  });
  assert.equal(requests, 1);
});

test('native timeout exceptions become recoverable errors without writing readonly code', async () => {
  await assert.rejects(streamCompletion({ request: async () => { throw new DOMException('expired', 'TimeoutError'); } },
    completionBody({ message: 'fixture' }), { timeoutMs: 1 }), error => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.result.accepted, false);
    assert.equal(error.result.requestDispatched, true);
    return true;
  });
});

test('local transport defaults to sse and accepts ws override', () => {
  assert.equal(resolveHeadlessLocalTransport({}), 'sse');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: '' }), 'sse');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'sse' }), 'sse');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'SSE' }), 'sse');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'ws' }), 'ws');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'frontier-ws' }), 'ws');
});

test('frontier keepalive defaults on outside win32 and accepts explicit disable', () => {
  if (process.platform === 'win32') {
    assert.equal(resolveFrontierKeepaliveEnabled({}), false);
    return;
  }
  assert.equal(resolveFrontierKeepaliveEnabled({}), true);
  assert.equal(resolveFrontierKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: '0' }), false);
  assert.equal(resolveFrontierKeepaliveEnabled({ DOUBAO_HEADLESS_FRONTIER_KEEPALIVE: 'off' }), false);
});

test('incomplete early replies include empty text and unclosed fences', () => {
  assert.equal(isIncompleteEarlyReply(''), true);
  assert.equal(isIncompleteEarlyReply('```'), true);
  assert.equal(isIncompleteEarlyReply('```\n'), true);
  assert.equal(isIncompleteEarlyReply('```\ntotal 0\n```'), false);
  assert.equal(isIncompleteEarlyReply('VISIBLE'), false);
});

test('end_type=1 early-complete upgrades an incomplete fence via later stream chunks', async () => {
  let push;
  const stream = new ReadableStream({
    start(controller) {
      push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      push(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`);
    },
  });
  const client = {
    request: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  };
  const pending = streamCompletion(client, completionBody({ message: 'fixture', mode: 'chat' }), {
    timeoutMs: 5000, waitForReply: true, earlyAnswerGraceMs: 1_500, earlyStreamDrainMs: 0,
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  push(`event: STREAM_CHUNK\ndata: ${JSON.stringify({
    patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, content: { text_block: { text: '```' } } },
    ] } }],
  })}\n\n`);
  await new Promise(resolve => setTimeout(resolve, 40));
  push(`event: STREAM_CHUNK\ndata: ${JSON.stringify({
    patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, content: { text_block: { text: '\ntotal 0\n```' } } },
    ] } }],
  })}\n\n`);
  await new Promise(resolve => setTimeout(resolve, 40));
  push(`event: SSE_REPLY_END\ndata: ${JSON.stringify({ end_type: 1, msg_finish_attr: { brief: '```\ntotal 0\n```' } })}\n\n`);
  const result = await pending;
  assert.equal(result.earlyComplete, 'end_type_1');
  assert.match(result.answer, /total 0/u);
  assert.equal(isIncompleteEarlyReply(result.answer), false);
});

test('end_type=1 early-complete unblocks before end_type=3', async () => {
  let push;
  const stream = new ReadableStream({
    start(controller) {
      push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      push(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`);
    },
  });
  const started = Date.now();
  const pending = streamCompletion(
    { request: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) },
    completionBody({ message: 'fixture', mode: 'chat' }),
    { timeoutMs: 5000, waitForReply: true, earlyAnswerGraceMs: 0, earlyStreamDrainMs: 0 },
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  push(`event: SSE_REPLY_END\ndata: ${JSON.stringify({ end_type: 1, msg_finish_attr: { brief: 'DONE' } })}\n\n`);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.equal(result.accepted, true);
  assert.equal(result.earlyComplete, 'end_type_1');
  assert.equal(result.answer, 'DONE');
  assert.equal(result.conversationId, conversationId);
  assert.ok(elapsed < 1000, `early-complete should finish quickly, took ${elapsed}ms`);
});

test('end_type=1 returns immediately while background-draining until end_type=3', async () => {
  let push;
  const stream = new ReadableStream({
    start(controller) {
      push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      push(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`);
    },
  });
  const pending = streamCompletion(
    { request: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) },
    completionBody({ message: 'fixture', mode: 'chat' }),
    { timeoutMs: 5000, waitForReply: true, earlyAnswerGraceMs: 0, earlyStreamDrainMs: 2_000 },
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  push(`event: SSE_REPLY_END\ndata: ${JSON.stringify({ end_type: 1, msg_finish_attr: { brief: 'VISIBLE' } })}\n\n`);
  const result = await pending;
  assert.equal(result.earlyComplete, 'end_type_1');
  assert.equal(result.answer, 'VISIBLE');
  assert.equal(result.streamFinished, null);
  await new Promise(resolve => setTimeout(resolve, 40));
  push(`event: SSE_REPLY_END\ndata: ${JSON.stringify({ end_type: 3 })}\n\n`);
  await result.streamDrain;
  assert.equal(result.streamFinished, 'end_type_3');
});
