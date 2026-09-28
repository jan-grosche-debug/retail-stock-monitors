require('./stub-deps');
const test = require('node:test');
const assert = require('node:assert/strict');

test('In-store adapters load and expose the common snapshot interface', () => {
  for (const m of ['galeria', 'rossmann', 'smyths']) {
    const mod = require(`../instore/${m}`);
    assert.equal(typeof mod.fetchEanSnapshot, 'function', `${m}.fetchEanSnapshot`);
  }
});
