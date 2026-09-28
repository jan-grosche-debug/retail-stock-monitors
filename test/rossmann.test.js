require('./stub-deps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal: r } = require('../instore/rossmann');

// Real snippet from rossmann.de product page payload (2026-09-28), escaped as in the RSC stream.
const LIVE = String.raw`"bestellschritte\":1,\"bewertbar\":true,\"dan\":\"195333\",\"ean\":\"4008491105224\",\"filialversandfaehig\"` +
  String.raw`,\"hasPriceHidden\":false,\"dan\":\"200640\",\"productUrl\":\"/baby-und-spielzeug\"`;

test('DAN is extracted from the new Next.js page payload for the requested EAN', () => {
  assert.deepEqual(r.extractDanFromHtml(LIVE, '4008491105224'), { dan: '195333', ean: '4008491105224' });
});

test('unrelated DANs on the page (recommendations) are not picked up', () => {
  assert.equal(r.extractDanFromHtml(LIVE, '0000000000000'), null);
});

test('unescaped JSON works too', () => {
  assert.deepEqual(r.extractDanFromHtml('{"dan":"084175","ean":"0820650850233"}', '0820650850233'), { dan: '084175', ean: '0820650850233' });
});

test('stock "5+" counts as in stock (was parsed as 0 before)', () => {
  assert.equal(r.parseStock('5+'), 5);
  assert.equal(r.parseStock('0'), 0);
  assert.equal(r.parseStock(undefined), 0);
  const s = r.normalizeStoreEntry({ id: 1, postcode: '48143', city: 'Münster', street: 'Ludgeristr. 54', productInfo: [{ available: true, dan: '195333', stock: '5+' }] });
  assert.equal(s.stock, 5);
  assert.equal(s.available, true);
});
