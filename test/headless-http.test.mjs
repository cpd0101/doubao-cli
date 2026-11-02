import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieJar, HeadlessClient, consumeSse, newDevice } from '../src/headless-http.mjs';

test('device metadata uses positive exact JSON integers and repairs older oversized identifiers', () => {
  assert.deepEqual(newDevice(size => Buffer.alloc(size, 255)), { web_id: '9007199254740991', device_id: '9007199254740991' });
  assert.deepEqual(newDevice(size => Buffer.alloc(size)), { web_id: '1', device_id: '1' });
  const valid = { web_id: '9007199254740991', device_id: '2' };
  assert.deepEqual(new HeadlessClient({ device: valid }).device, valid);
  const repaired = new HeadlessClient({ device: { web_id: '1', device_id: '11822967929082076286' } }).device;
  for (const value of Object.values(repaired)) assert.ok(BigInt(value) > 0n && BigInt(value) <= 9007199254740991n);
});

function streamResponse(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++]);
    },
  }), { status, headers: { 'content-type': contentType } });
}

test('headless HTTP sends cookies only to their allowed host and path', async () => {
  const jar = new CookieJar();
  jar.set('main=main-secret; Domain=doubao.com; Path=/chat; Secure', 'https://www.doubao.com');
  jar.set('passport=passport-secret; Path=/passport', 'https://passport.doubao.com');
  jar.set('passport_csrf_token=csrf-secret; Path=/passport', 'https://passport.doubao.com');
  jar.set('host=www-only; Path=/', 'https://www.doubao.com');
  const calls = [];
  const client = new HeadlessClient({ cookies: jar, device: { web_id: '1', device_id: '2' }, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response('{}');
  } });

  await client.request('https://www.doubao.com/chat/completion');
  await client.request('https://www.doubao.com/im/chain/recent_conv');
  await client.request('https://passport.doubao.com/passport/account/info/v2/');

  assert.equal(calls[0].init.headers.cookie, 'main=main-secret; host=www-only');
  assert.equal(calls[0].init.headers['x-tt-passport-csrf-token'], undefined);
  assert.equal(calls[1].init.headers.cookie, 'host=www-only');
  assert.equal(calls[2].init.headers.cookie, 'passport=passport-secret; passport_csrf_token=csrf-secret');
  assert.equal(calls[2].init.headers['x-tt-passport-csrf-token'], 'csrf-secret');
  assert.ok(calls.every(call => call.init.redirect === 'manual'));
  await assert.rejects(client.request('https://attacker.invalid/collect'), /approved Doubao HTTPS endpoint/u);
});

test('headless HTTP errors never echo server response bodies or cookie values', async () => {
  const privateValue = 'private-response-cookie-secret';
  const client = new HeadlessClient({ cookies: CookieJar.import(`sessionid=${privateValue}`), fetchImpl: async () =>
    new Response(`denied ${privateValue}`, { status: 403 }) });
  await assert.rejects(client.json('/im/private', { timeoutMs: 100 }), error => {
    assert.equal(error.code, 'login_required');
    assert.doesNotMatch(error.message, /private-response-cookie-secret/u);
    return true;
  });

  const invalidJson = new HeadlessClient({ fetchImpl: async () => new Response(`bad ${privateValue}`) });
  await assert.rejects(invalidJson.json('/im/private'), error => {
    assert.match(error.message, /invalid JSON/u);
    assert.doesNotMatch(error.message, /private-response-cookie-secret/u);
    return true;
  });
});

test('cookie expiry wins over attribute order and implicit paths do not leak', () => {
  const jar = new CookieJar();
  jar.set('expired=private; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'https://www.doubao.com/passport/check');
  jar.set('scoped=private', 'https://www.doubao.com/passport/check');
  assert.equal(jar.header('https://www.doubao.com/im/conversation/batch_get'), '');
  assert.equal(jar.header('https://www.doubao.com/passport/check'), 'scoped=private');
  assert.throws(() => jar.set('bad=secret\r\nvalue', 'https://www.doubao.com'), /Invalid cookie data/u);
});

test('SSE parser handles UTF-8 and CRLF split across arbitrary byte chunks', async () => {
  const text = 'event: MESSAGE\r\nid: 17\r\ndata: {"text":"你好 🐼"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  // Split inside a multi-byte character and inside CRLF delimiters.
  const chunks = [bytes.slice(0, 35), bytes.slice(35, 43), bytes.slice(43, 46), bytes.slice(46)];
  const events = [];
  await consumeSse(streamResponse(chunks), (event, data, id) => events.push({ event, data, id }));
  assert.deepEqual(events, [{ event: 'MESSAGE', data: { text: '你好 🐼' }, id: '17' }]);
});

test('SSE parser fails closed for HTTP errors, wrong content type, and malformed event JSON', async () => {
  await assert.rejects(consumeSse(streamResponse([], { status: 502 }), () => {}), /did not return an event stream \(502\)/u);
  await assert.rejects(consumeSse(streamResponse([], { contentType: 'application/json' }), () => {}), /did not return an event stream/u);
  const malformed = new TextEncoder().encode('event: MESSAGE\ndata: {broken}\n\n');
  await assert.rejects(consumeSse(streamResponse([malformed]), () => {}), /invalid JSON/u);
});

test('an unterminated final SSE frame is not delivered as a completed event', async () => {
  const bytes = new TextEncoder().encode('event: MESSAGE\ndata: {"ok":true}');
  const events = [];
  await consumeSse(streamResponse([bytes]), (...event) => events.push(event));
  assert.deepEqual(events, []);
});

test('consumeSse exits promptly when its abort signal fires during a blocked read', async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream({
    start() {
      // Never enqueue or close — reader.read() stays pending until abort.
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const started = Date.now();
  const pending = consumeSse(response, () => {}, { signal: controller.signal });
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 30);
  await pending;
  assert.ok(Date.now() - started < 500, `abort should unblock consumeSse quickly, took ${Date.now() - started}ms`);
});
