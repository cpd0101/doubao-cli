import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentTaskStatusTracker, dispatchPayloadToLocalFrame, extractAgentTaskStatusEvents,
  extractDispatchPayloads,
} from '../src/headless-frontier-ws.mjs';

function frameWith(value) {
  return Buffer.from(`xx${JSON.stringify(value)}yy`);
}

test('extractAgentTaskStatusEvents parses Desktop-style notifies', () => {
  const buffer = frameWith({
    cmd: 10,
    downlink_body: {
      common_cmd_notify: {
        biz_code: 'agent_task_status',
        value: JSON.stringify({
          operation: 1,
          status: {
            status_key: 'moa:main_agent',
            group_key: 'conversation:38449959845788162',
            meta_id: 'TASK_RUNNING',
          },
          meta: { meta_id: 'TASK_RUNNING' },
        }),
      },
    },
  });
  const events = extractAgentTaskStatusEvents(buffer);
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 1);
  assert.equal(events[0].metaId, 'TASK_RUNNING');
  assert.equal(events[0].conversationId, '38449959845788162');
});

test('agent task status tracker settles when REPLYING is cleared', async () => {
  const tracker = createAgentTaskStatusTracker();
  const conversationId = '38449959845788162';
  const groupKey = `conversation:${conversationId}`;
  tracker.apply({ operation: 1, groupKey, metaId: 'TASK_RUNNING', conversationId });
  assert.equal(tracker.isSettled(conversationId), false);
  tracker.apply({ operation: 1, groupKey, metaId: 'REPLYING', conversationId });
  const waiting = tracker.waitUntilSettled(conversationId, { timeoutMs: 1000 });
  tracker.apply({ operation: 2, groupKey, metaId: 'REPLYING', conversationId });
  const result = await waiting;
  assert.equal(result.reason, 'agent_task_status');
  assert.equal(tracker.isSettled(conversationId), true);
  // Native paths may leave TASK_RUNNING behind after REPLYING clears.
  assert.deepEqual(tracker.activeMetaIds(conversationId), ['TASK_RUNNING']);
});

test('dispatch payload mapping still works beside status frames', () => {
  const payloads = extractDispatchPayloads(frameWith({
    command: 6003,
    body: {
      cmd_call: {
        id: 'command-1',
        name: 'local.workspace.apply',
        input: '{}',
        need_ack: true,
        agent_meta: { sandbox_id: 'cli-1', conversation_id: '38449959845788162' },
      },
    },
  }));
  assert.equal(payloads.length, 1);
  const frame = dispatchPayloadToLocalFrame(payloads[0]);
  assert.equal(frame.event_type, 2);
  assert.equal(frame.command.name, 'local.workspace.apply');
});
