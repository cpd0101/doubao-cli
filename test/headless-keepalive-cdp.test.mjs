import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachFrontierHiKeepalive } from '../src/headless-frontier-ws.mjs';
import { createChunkStreamKeepalive } from '../src/headless-local-runtime.mjs';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  addEventListener(type, listener) {
    this.on(type, listener);
  }

  removeEventListener(type, listener) {
    this.off(type, listener);
  }
}

function createFakeTimers() {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, due: now + Math.max(0, ms) });
    return id;
  };
  const clearTimer = (id) => { timers.delete(id); };
  const advance = (ms) => {
    now += ms;
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of timers) {
        if (timer.due <= now && timer.due < dueAt) {
          dueAt = timer.due;
          dueId = id;
        }
      }
      if (dueId == null) break;
      const timer = timers.get(dueId);
      timers.delete(dueId);
      timer.fn();
    }
  };
  return {
    now: () => now,
    setTimer,
    clearTimer,
    advance,
    pending: () => timers.size,
  };
}

function readableFromChunks(chunks, { hang = true, signal, onCancel } = {}) {
  let index = 0;
  let cancelled = false;
  return {
    getReader() {
      return {
        async read() {
          if (cancelled) return { done: true, value: undefined };
          if (index < chunks.length) {
            const value = chunks[index++];
            return { done: false, value };
          }
          if (!hang) return { done: true, value: undefined };
          // Stay open until abort/cancel so silence timers can fire (Desktop standing SSE).
          await new Promise((resolve, reject) => {
            const done = () => resolve();
            if (signal?.aborted || cancelled) {
              done();
              return;
            }
            signal?.addEventListener('abort', done, { once: true });
            const poll = setInterval(() => {
              if (cancelled || signal?.aborted) {
                clearInterval(poll);
                done();
              }
            }, 5);
          });
          return { done: true, value: undefined };
        },
        async cancel() {
          cancelled = true;
          onCancel?.();
        },
      };
    },
    async cancel() {
      cancelled = true;
      onCancel?.();
    },
  };
}

test('Frontier hi keepalive sends hi after idle and closes after ping losses', () => {
  const socket = new FakeSocket();
  const clock = createFakeTimers();
  const closes = [];
  const keepalive = attachFrontierHiKeepalive(socket, {
    pingIntervalMs: 15_000,
    pingTimeoutMs: 4_000,
    pingLossLimit: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onClose: (reason) => closes.push(reason),
  });

  clock.advance(14_999);
  assert.deepEqual(socket.sent, []);
  clock.advance(1);
  assert.deepEqual(socket.sent, ['hi']);
  assert.equal(keepalive.waitingForPong, true);

  // Miss first pong → one loss, re-arm idle.
  clock.advance(4_000);
  assert.equal(keepalive.losses, 1);
  assert.equal(closes.length, 0);

  clock.advance(15_000);
  assert.deepEqual(socket.sent, ['hi', 'hi']);
  clock.advance(4_000);
  assert.equal(keepalive.losses, 2);
  assert.deepEqual(closes, ['ping_loss']);
  assert.equal(socket.closed, true);

  keepalive.stop();
});

test('Frontier hi keepalive treats inbound frames as pong and resets losses', () => {
  const socket = new FakeSocket();
  const clock = createFakeTimers();
  const keepalive = attachFrontierHiKeepalive(socket, {
    pingIntervalMs: 10_000,
    pingTimeoutMs: 2_000,
    pingLossLimit: 2,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  clock.advance(10_000);
  assert.deepEqual(socket.sent, ['hi']);
  socket.emit('message', Buffer.from('pong'));
  assert.equal(keepalive.waitingForPong, false);
  assert.equal(keepalive.losses, 0);

  clock.advance(10_000);
  assert.deepEqual(socket.sent, ['hi', 'hi']);
  keepalive.stop();
  assert.equal(clock.pending(), 0);
});

test('chunk_stream keepalive reconnects after silence and pauses for turns', async () => {
  const opens = [];
  const cancels = [];
  let openCount = 0;
  const openChannel = async (_client, params) => {
    openCount += 1;
    opens.push({ ...params, openCount });
    const signal = params.signal;
    if (signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    // Stream one chunk then hang until silence/pause abort (Desktop standing SSE).
    return {
      body: readableFromChunks([Buffer.from('id: evt-1\ndata: {}\n\n')], {
        hang: true,
        signal,
        onCancel: () => cancels.push(openCount),
      }),
    };
  };

  const sleeps = [];
  const keepalive = createChunkStreamKeepalive({
    client: {},
    sandboxId: 'hub-sse-test',
    deviceId: '99',
    silenceTimeoutMs: 50,
    minBackoffMs: 10,
    maxBackoffMs: 10,
    openChannel,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(openCount >= 1);
  assert.equal(opens[0].sandboxId, 'hub-sse-test');
  assert.equal(opens[0].deviceId, '99');

  // Silence timeout should abort and reconnect.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(openCount >= 2, `expected reconnect after silence, opens=${openCount}`);
  assert.equal(keepalive.lastEventId, 'evt-1');

  keepalive.pause();
  const opensAtPause = openCount;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(openCount, opensAtPause, 'pause must not open new standing channels');

  keepalive.resume();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(openCount > opensAtPause, 'resume must re-open standing channel');

  await keepalive.stop();
  const opensAtStop = openCount;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(openCount, opensAtStop);
  assert.ok(cancels.length >= 1);
});
