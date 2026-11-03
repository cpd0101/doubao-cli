import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFrontierWsUrl,
  createAgentTaskStatusTracker, dispatchPayloadToLocalFrame, extractAgentTaskStatusEvents,
  extractConversationLoadingEvents,
  extractDispatchPayloads,
} from '../src/headless-frontier-ws.mjs';

function frameWith(value) {
  return Buffer.from(`xx${JSON.stringify(value)}yy`);
}

test('Frontier ws URL disables auto-ack flags like Desktop defaults', () => {
  const url = buildFrontierWsUrl({
    ws_domain: 'wss://frontier.example',
    ws_access_key: 'key',
    ws_product_id: 13,
    ws_app_id: 48,
  }, { deviceId: '123456' });
  const query = new URL(url).searchParams;
  assert.equal(query.get('xaack'), '0');
  assert.equal(query.get('xsack'), '0');
  assert.equal(query.get('device_id'), '123456');
  assert.equal(query.get('conn_tag'), 'desktop_work');
});

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

test('extractConversationLoadingEvents parses cmd 50002 is_loading', () => {
  const buffer = frameWith({
    cmd: 50002,
    downlink_body: {
      update_conv_info_notify: {
        conversation_info: {
          conversation_id: '38449959845788162',
          extra: JSON.stringify({ is_loading: '0', running_messages: '{}' }),
        },
      },
    },
  });
  const events = extractConversationLoadingEvents(buffer);
  assert.equal(events.length, 1);
  assert.equal(events[0].conversationId, '38449959845788162');
  assert.equal(events[0].isLoading, '0');
});

test('tracker settles on is_loading=0 after is_loading=1, not on REPLYING clear', async () => {
  const tracker = createAgentTaskStatusTracker();
  const conversationId = '38449959845788162';
  const groupKey = `conversation:${conversationId}`;
  tracker.apply({ operation: 1, groupKey, metaId: 'TASK_RUNNING', conversationId });
  tracker.apply({ operation: 1, groupKey, metaId: 'REPLYING', conversationId });
  tracker.apply({ operation: 2, groupKey, metaId: 'REPLYING', conversationId });
  assert.equal(tracker.isSettled(conversationId), false);
  assert.deepEqual(tracker.activeMetaIds(conversationId), ['TASK_RUNNING']);

  const waiting = tracker.waitUntilSettled(conversationId, { timeoutMs: 1000 });
  tracker.applyLoading({ conversationId, isLoading: '1' });
  assert.equal(tracker.isSettled(conversationId), false);
  tracker.applyLoading({ conversationId, isLoading: '0' });
  const result = await waiting;
  assert.equal(result.reason, 'is_loading');
  assert.equal(tracker.isSettled(conversationId), true);
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
