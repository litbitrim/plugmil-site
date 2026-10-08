import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../contact.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const contactMarkup = html.slice(html.indexOf('<form id="fm"'), html.indexOf('</form>', html.indexOf('<form id="fm"')));

function client(fetchImpl) {
  let submitHandler, resetCount = 0, uuidCount = 0;
  const elements = {};
  for (const match of contactMarkup.matchAll(/name="([^"]+)"/g)) elements[match[1]] = { value: '' };
  Object.assign(elements.name, { value: 'Testbetrieb' });
  Object.assign(elements.email, { value: 'kunde@example.org' });
  Object.assign(elements.service, { value: 'website' });
  Object.assign(elements.message, { value: 'Eine Website für meinen Betrieb.' });
  Object.assign(elements.privacy, { checked: true });
  const status = { dataset: {}, hidden: true, textContent: '' };
  const submit = { disabled: false };
  const form = {
    elements, reportValidity: () => true,
    addEventListener(type, fn) { if (type === 'submit') submitHandler = fn; },
    setAttribute() {}, removeAttribute() {},
    reset() { resetCount++; for (const field of Object.values(elements)) { field.value = ''; field.checked = false; } },
  };
  const map = { fm: form, 'contact-status': status, 'contact-submit': submit };
  vm.runInNewContext(source, {
    document: { getElementById: id => map[id] },
    fetch: fetchImpl,
    AbortSignal,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}` },
  });
  return { elements, status, submit, send: () => submitHandler({ preventDefault() {} }), resets: () => resetCount };
}

test('UI retains user inputs and request UUID for retry after an uncertain failure', async () => {
  const requests = [];
  const ui = client(async (url, options) => { requests.push(JSON.parse(options.body)); throw new Error('network timeout'); });
  await ui.send();
  await ui.send();
  assert.equal(ui.resets(), 0);
  assert.equal(ui.elements.message.value, 'Eine Website für meinen Betrieb.');
  assert.equal(ui.status.dataset.state, 'error');
  assert.equal(requests[0].requestId, requests[1].requestId);
  ui.elements.message.value += ' Mit neuen Inhalten.';
  await ui.send();
  assert.notEqual(requests[1].requestId, requests[2].requestId);
});

test('UI resets only after matching HTTP 202 provider acceptance', async () => {
  const ui = client(async (url, options) => new Response(JSON.stringify({ status: 'accepted', requestId: JSON.parse(options.body).requestId }), { status: 202 }));
  await ui.send();
  assert.equal(ui.resets(), 1);
  assert.equal(ui.status.dataset.state, 'accepted');
  assert.match(ui.status.textContent, /Versanddienst angenommen/);
  assert.equal(ui.submit.disabled, false);
});

test('a generic HTTP 200 or a mismatched request ID is not shown as success', async () => {
  for (const response of [new Response('{}'), new Response('{"status":"accepted","requestId":"wrong"}', { status: 202 })]) {
    const ui = client(async () => response);
    await ui.send();
    assert.equal(ui.resets(), 0);
    assert.equal(ui.status.dataset.state, 'error');
  }
});

test('a second click while sending cannot issue a duplicate browser request', async () => {
  let resolve, calls = 0;
  const ui = client(() => { calls++; return new Promise(r => { resolve = r; }); });
  const pending = ui.send();
  assert.equal(ui.submit.disabled, true);
  await ui.send();
  assert.equal(calls, 1);
  resolve(new Response('{"error":"rate_limited"}', { status: 429 }));
  await pending;
  assert.equal(ui.submit.disabled, false);
});

test('all inline page scripts parse, and the main style contains no script code', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(!style.includes('function calc('));
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
