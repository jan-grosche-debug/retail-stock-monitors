require('./stub-deps');
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../online/sites/shopifyCore');
const { SHOPIFY_PRESETS, BROWSER_PRESETS, BOOK_PRESETS } = require('../online/sites/presets');
const catalog = require('../online/bot/catalog');
const track = require('../online/bot/track');
const live = require('./fixtures/tcgviert-live-2026-09-28.json');

test('Shopify: handle is resolved from a real /search/suggest.json response', () => {
  assert.equal(core.handleFromSuggest(live.suggest), 'pokemon-tcg-battle-partners-display-sv9-jp');
});

test('Shopify: snapshot from a real /products/<handle>.js response (in stock, price in €)', () => {
  const snap = core.snapshotFromProduct(live.product, { id: 't1', domain: 'tcgviert.com', handle: live.product.handle, ean: '4521329362649' });
  assert.equal(snap.available, true);
  assert.equal(snap.price, 79.99);
  assert.equal(snap.url, 'https://tcgviert.com/products/pokemon-tcg-battle-partners-display-sv9-jp');
  assert.match(snap.image, /^https:\/\/cdn\.shopify\.com\//);
});

test('Shopify: EAN picks the matching variant, sold-out variant => not available', () => {
  const product = { title: 'X', variants: [
    { available: false, price: 1000, barcode: '111' },
    { available: true, price: 2000, barcode: '222' },
  ] };
  const a = core.snapshotFromProduct(product, { id: 'a', domain: 'd.de', handle: 'x', ean: '111' });
  assert.equal(a.available, false);
  const b = core.snapshotFromProduct(product, { id: 'b', domain: 'd.de', handle: 'x', ean: '222' });
  assert.equal(b.available, true);
  assert.equal(b.price, 20);
});

test('Presets: only the 19 live-verified Shopify shops, no browser/book presets', () => {
  assert.equal(SHOPIFY_PRESETS.length, 19);
  assert.equal(BROWSER_PRESETS.length, 0);
  assert.equal(BOOK_PRESETS.length, 0);
  assert.equal(new Set(SHOPIFY_PRESETS.map((p) => p.key)).size, 19);
});

test('Catalog: URLs route to the right adapter, unknown hosts fall back to generic Shopify', () => {
  assert.equal(catalog.siteForUrl('https://tcgviert.com/products/x'), 'tcgviert');
  assert.equal(catalog.siteForUrl('https://www.kofuku.de/products/x'), 'kofuku');
  assert.equal(catalog.siteForUrl('https://some-other-shop.de/products/x'), 'shopify');
  for (const s of catalog.SITES) assert.ok(s.key && s.label, 'every catalog entry has key + label');
});
