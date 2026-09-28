// Regression test: the TLS client must hand callers the response body as TEXT,
// whether cycletls returns a text() reader (2.x) or an already-parsed JSON object (1.x).
// Before the fix, the 1.x shape produced an empty body and Galeria looked "broken".
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');

let cycleResponse = null;
const fakeCycle = async () => cycleResponse;
fakeCycle.exit = async () => {};
const STUBS = {
  cycletls: async () => fakeCycle,
  axios: { create: () => ({}) },
  'axios-cookiejar-support': { wrapper: (x) => x },
  'tough-cookie': { CookieJar: class { async getCookieString() { return ''; } async setCookie() {} } },
  'https-proxy-agent': { HttpsProxyAgent: class {} },
  'http-proxy-agent': { HttpProxyAgent: class {} },
};
const orig = Module._load;
Module._load = function (req, ...rest) { return req in STUBS ? STUBS[req] : orig.call(this, req, ...rest); };
const { createRequestClient } = require('../lib/requestClient');

const PAYLOAD = [[{ city: 'Köln' }], [{ store: { name: 'GALERIA Köln Hohe Straße' } }]];

test('cycletls 2.x shape (text() reader) → body is JSON text', async () => {
  cycleResponse = { status: 200, headers: {}, text: async () => JSON.stringify(PAYLOAD) };
  const res = await createRequestClient().post('https://example.test/api', { data: '[]' });
  assert.deepEqual(JSON.parse(res.data), PAYLOAD);
});

test('cycletls 1.x shape (auto-parsed JSON object) → body is still JSON text', async () => {
  cycleResponse = { status: 200, headers: {}, body: PAYLOAD };
  const res = await createRequestClient().post('https://example.test/api', { data: '[]' });
  assert.deepEqual(JSON.parse(res.data), PAYLOAD);
});

test('plain string body is passed through unchanged', async () => {
  cycleResponse = { status: 200, headers: {}, body: '<html>ok</html>' };
  const res = await createRequestClient().get('https://example.test/');
  assert.equal(res.data, '<html>ok</html>');
});
