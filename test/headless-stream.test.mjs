import test from 'node:test';
import assert from 'node:assert/strict';
import { completionBody, resolveHeadlessLocalTransport, streamCompletion } from '../src/headless.mjs';

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

test('local transport defaults to frontier-ws and accepts http-sse override', () => {
  assert.equal(resolveHeadlessLocalTransport({}), 'frontier-ws');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: '' }), 'frontier-ws');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'frontier-ws' }), 'frontier-ws');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'http-sse' }), 'http-sse');
  assert.equal(resolveHeadlessLocalTransport({ DOUBAO_HEADLESS_LOCAL_TRANSPORT: 'SSE' }), 'http-sse');
});

test('agent_task_status early-complete unblocks a hung completion body promptly', async () => {
  const hanging = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`));
      // Leave the stream open so reader.read() would otherwise wait for end_type=3.
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const agentStatus = {
    waitUntilSettled: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { reason: 'agent_task_status' };
    },
  };
  const started = Date.now();
  const result = await streamCompletion(
    { request: async () => hanging },
    completionBody({ message: 'fixture', mode: 'chat' }),
    { timeoutMs: 5000, waitForReply: true, agentStatus, earlyAnswerGraceMs: 0 },
  );
  const elapsed = Date.now() - started;
  assert.equal(result.accepted, true);
  assert.equal(result.earlyComplete, 'agent_task_status');
  assert.equal(result.conversationId, conversationId);
  assert.ok(elapsed < 1000, `early-complete should finish quickly, took ${elapsed}ms`);
});

test('ui settle keeps the stream until the visible answer arrives', async () => {
  let push;
  const stream = new ReadableStream({
    start(controller) {
      push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      push(`event: SSE_ACK\ndata: ${JSON.stringify(ack)}\n\n`);
    },
  });
  const agentStatus = {
    waitUntilSettled: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { reason: 'agent_task_status' };
    },
  };
  const pending = streamCompletion(
    { request: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) },
    completionBody({ message: 'fixture', mode: 'chat' }),
    { timeoutMs: 5000, waitForReply: true, agentStatus, earlyAnswerGraceMs: 2_000 },
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  push(`event: STREAM_CHUNK\ndata: ${JSON.stringify({
    patch_op: [{ patch_value: { content_block: [
      { block_type: 10000, content: { text_block: { text: 'VISIBLE' } } },
    ] } }],
  })}\n\n`);
  const result = await pending;
  assert.equal(result.earlyComplete, 'agent_task_status');
  assert.equal(result.answer, 'VISIBLE');
});
