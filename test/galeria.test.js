require('./stub-deps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal: g } = require('../instore/galeria');

// Shape recorded live from the Galeria store finder on 2026-09-28 (EAN 4005555010753:
// 14 of 83 stores stocked). Stores without stock carry no pickupAvailability at all.
const LIVE_STORES = [
  { store: { name: 'GALERIA Köln Hohe Straße', city: 'Köln', zip: '50667' },
    pickupAvailability: { strategy: 'clickAndReserve', pickupAvailable: true, pickupFromDateTime: '2026-09-29T14:15:00.000+0200' } },
  { store: { name: 'GALERIA Köln-Nippes', city: 'Köln', zip: '50733' } },
  { store: { name: 'GALERIA Bonn', city: 'Bonn', zip: '53111' },
    pickupAvailability: { strategy: 'shipToStore', pickupAvailable: true } },
  { store: { name: 'GALERIA Aachen', city: 'Aachen', zip: '52062' },
    pickupAvailability: { strategy: 'clickAndReserve', pickupAvailable: false } },
];

test('physical mode: only stores with in-branch stock (clickAndReserve + available)', () => {
  const s = g.pickStockedStores(LIVE_STORES, 'physical');
  assert.deepEqual(s.map((x) => x.name), ['GALERIA Köln Hohe Straße']);
});

test('any mode: also counts ship-to-store availability', () => {
  const s = g.pickStockedStores(LIVE_STORES, 'any');
  assert.deepEqual(s.map((x) => x.name), ['GALERIA Bonn', 'GALERIA Köln Hohe Straße']);
});
