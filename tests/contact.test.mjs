import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  createContactHandler, validateContact, getConfig, isAllowedOrigin, clientIp,
  enforceRateLimit, sendContact, RECIPIENT,
} from '../lib/contact.mjs';

const body = {
  name: 'Website Testbetrieb', email: 'kunde@example.org', service: 'website',
  message: 'Ich benötige eine neue Website für meinen Betrieb.',
  website: '', privacy: true, requestId: 'f8448f9d-b3c6-4fb1-bfcf-964a63703616',
};
const env = {
  RESEND_API_KEY: 'test-resend-not-a-real-key',
  CONTACT_FROM: 'plugmil <anfragen@example.org>',
  UPSTASH_REDIS_REST_URL: 'https://test-contact.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'test-redis-not-a-real-key',
  VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'plugmil-test.vercel.app',
};
const success = () => new Response(JSON.stringify({ id: 'provider-accepted-test' }), { status: 200 });
const allowed = () => new Response(JSON.stringify({ result: [1, 0] }), { status: 200 });
const logger = { info() {}, warn() {} };

async function invoke({ overrides = {}, input = body, method = 'POST', headers = {}, external } = {}) {
  const calls = [];
  const handler = createContactHandler({
    env: { ...env, ...overrides }, logger,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return external ? external(url, options) : (url.includes('upstash.io') ? allowed() : success());
    },
  });
  const req = {
    method, body: input,
    headers: { origin: 'https://plugmil.dev', 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.5', ...headers },
  };
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = JSON.parse(value); } };
  await handler(req, response);
  return { ...response, calls };
}

test('valid enquiry reaches the fixed owner address, with reply-to and stable idempotency', async () => {
  const response = await invoke({ input: { ...body, to: 'attacker@example.com', from: 'attacker@example.com' } });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { status: 'accepted', requestId: body.requestId });
  const email = JSON.parse(response.calls[1].options.body);
  assert.deepEqual(email.to, [RECIPIENT]);
  assert.equal(email.reply_to, body.email);
  assert.equal(email.from, env.CONTACT_FROM);
  assert.equal(response.calls[1].options.headers['Idempotency-Key'], `plugmil-contact:${body.requestId}`);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.ok(!JSON.stringify(response.body).includes('provider-accepted-test'));
});

for (const [label, invalid] of [
  ['empty name', { name: '' }],
  ['header injection', { email: 'kunde@example.org\r\nBcc: attacker@example.org' }],
  ['bad email', { email: 'kein-email' }],
  ['short message', { message: 'hi' }],
  ['long message', { message: 'x'.repeat(5001) }],
  ['unacknowledged privacy', { privacy: false }],
  ['honeypot', { website: 'https://spam.example.org' }],
  ['unsupported service', { service: 'send_to_arbitrary_recipient' }],
  ['missing request id', { requestId: '' }],
]) {
  test(`rejects ${label} before touching providers`, async () => {
    const response = await invoke({ input: { ...body, ...invalid } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.calls.length, 0);
  });
}

test('foreign origin, missing origin and HTML submissions cannot trigger email', async () => {
  for (const headers of [{ origin: 'https://evil.example.org' }, { origin: '' }, { 'content-type': 'application/x-www-form-urlencoded' }]) {
    const response = await invoke({ headers });
    assert.ok([403, 415].includes(response.statusCode));
    assert.equal(response.calls.length, 0);
  }
});

test('GET never sends and advertises POST', async () => {
  const response = await invoke({ method: 'GET' });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'POST');
  assert.equal(response.calls.length, 0);
});

test('missing provider configuration fails closed without a false success', async () => {
  for (const key of ['RESEND_API_KEY', 'CONTACT_FROM', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    const response = await invoke({ overrides: { [key]: '' } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'service_unavailable' });
    assert.equal(response.calls.length, 0);
  }
});

test('provider credentials only target the fixed HTTPS services', () => {
  for (const url of ['http://test-contact.upstash.io', 'https://example.org', 'https://test-contact.upstash.io/?target=elsewhere', 'https://user:pass@test-contact.upstash.io']) {
    assert.throws(() => getConfig({ ...env, UPSTASH_REDIS_REST_URL: url }));
  }
  assert.throws(() => getConfig({ ...env, CONTACT_FROM: 'a@example.org\r\nBcc: b@example.org' }));
});

test('rate limiting returns Retry-After and does not contact the email provider', async () => {
  const response = await invoke({ external: async () => new Response(JSON.stringify({ result: [0, 480] })) });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['Retry-After'], '480');
  assert.equal(response.calls.length, 1);
});

test('shared rate operation excludes raw IP, email and message text', async () => {
  let captured;
  await enforceRateLimit(getConfig(env), '203.0.113.5', body.email, async (url, options) => { captured = options; return allowed(); });
  const command = JSON.parse(captured.body);
  assert.equal(command[0], 'EVAL');
  assert.equal(command[2], 3);
  assert.ok(!captured.body.includes(body.email));
  assert.ok(!captured.body.includes('203.0.113.5'));
  assert.ok(!captured.body.includes(body.message));
});

test('Redis errors or unparseable responses fail closed', async () => {
  for (const external of [async () => { throw new Error('timeout'); }, async () => new Response('{"error":"backend down"}'), async () => new Response('not JSON')]) {
    const response = await invoke({ external });
    assert.equal(response.statusCode, 503);
    assert.equal(response.calls.length, 1);
  }
});

test('email provider errors, no ID and network timeout cannot produce accepted', async () => {
  for (const emailResponse of [async () => new Response('{"message":"bad auth"}', { status: 401 }), async () => new Response('{}'), async () => { throw new Error('timeout'); }]) {
    const response = await invoke({ external: (url) => url.includes('upstash.io') ? allowed() : emailResponse() });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, { error: 'send_unconfirmed' });
  }
});

test('local development origin cannot be enabled on Vercel', () => {
  assert.equal(isAllowedOrigin('http://localhost:4173', { VERCEL: '1', CONTACT_LOCAL_DEV: '1' }), false);
  assert.equal(isAllowedOrigin('http://localhost:4173', { CONTACT_LOCAL_DEV: '1' }), true);
  assert.equal(isAllowedOrigin('https://plugmil-test.vercel.app', env), true);
  assert.equal(isAllowedOrigin('https://attacker.vercel.app', env), false);
});

test('untrusted x-forwarded-for is ignored and IPv6 privacy addresses share /64', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.250' }, socket: { remoteAddress: '127.0.0.1' } }, {}), '127.0.0.1');
  assert.equal(clientIp({ headers: { 'x-vercel-forwarded-for': '2001:db8:1234:5678::1' } }, env), clientIp({ headers: { 'x-vercel-forwarded-for': '2001:db8:1234:5678:12:34:56:78' } }, env));
  assert.throws(() => clientIp({ headers: { 'x-forwarded-for': '203.0.113.5' } }, env));
});

test('HTTP stream: malformed or oversized bodies are rejected before providers', async t => {
  let outbound = 0;
  const handler = createContactHandler({ env: { ...env, VERCEL: '', CONTACT_LOCAL_DEV: '1' }, logger, fetchImpl: async () => { outbound++; return success(); } });
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [payload, expected] of [['{broken', 400], ['x'.repeat(40000), 413]]) {
    const response = await fetch(url, { method: 'POST', headers: { origin: 'http://localhost:4173', 'content-type': 'application/json' }, body: payload });
    assert.equal(response.status, expected);
  }
  assert.equal(outbound, 0);
});
