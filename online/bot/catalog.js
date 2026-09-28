// Site catalog for the Discord bot's /add flow.
//
// Core (hand-written adapter) sites + data-driven presets from sites/presets.js.
// Each entry: { key, label, emoji, kind, category, pools[], hint, domain? }
//   kind:     identifier the shop needs in /add — "ean" | "pid" | "asin" | "url"
//   category: feine Einordnung (Metadata; NICHT mehr der Picker)
//   pools:    Auswahl-Gruppen im Picker — ein Shop darf in MEHREREN liegen
//             (tcg | sneaker-fashion | technik | preisvergleiche | random).
//             Berechnet aus sites/pools.js → dort wird zugeordnet, nicht hier.
//
// "url" shops are routed by the URL's domain (siteForUrl), so the user just
// pastes a product URL. MediaMarkt & Saturn share one PID.

const { SHOPIFY_PRESETS, BROWSER_PRESETS, BOOK_PRESETS } = require('../sites/presets');
const { POOL_ORDER, POOL_META, poolsFor } = require('../sites/pools');

const CORE = [
  // ── Generic ──
  { key: 'shopify', label: 'Any Shopify shop (by URL)', emoji: '🛍️', kind: 'url', category: 'Sonstige',
    hint: 'Produkt-URL eines beliebigen Shopify-Shops' },
  // ── TCG / Sammelkarten ──
  { key: 'tcgviert', label: 'TCGViert', emoji: '🃏', kind: 'ean', category: 'TCG',
    hint: 'EAN oder Produkt-URL — tcgviert.com (Shopify)' },
  { key: 'feenturm', label: 'Feenturm', emoji: '🧚', kind: 'ean', category: 'TCG',
    hint: 'EAN oder Produkt-URL — feenturm.de (Shopify)' }
];

// Turn a preset row into a catalog entry.
function presetEntry(p, transport) {
  const platform = transport === 'shopify' ? 'Shopify' : transport === 'book' ? 'Buchhandlung' : 'Browser';
  const idHint = p.kind === 'ean' ? 'EAN oder Produkt-URL' : 'Produkt-URL';
  const proxy = p.walled ? ' — braucht ggf. Proxy' : '';
  return { key: p.key, label: p.label, emoji: p.emoji, kind: p.kind, category: p.category,
    domain: p.domain, hint: `${idHint} — ${p.domain} (${platform})${proxy}` };
}

// Every catalog entry carries its pools[] (multi-membership, from sites/pools.js).
function withPools(s) { return { ...s, pools: poolsFor(s) }; }

const SITES = [
  ...CORE,
  ...SHOPIFY_PRESETS.map((p) => presetEntry(p, 'shopify')),
  ...BROWSER_PRESETS.map((p) => presetEntry(p, 'browser')),
  ...BOOK_PRESETS.map((p) => presetEntry(p, 'book'))
].map(withPools);

const BY_KEY = Object.fromEntries(SITES.map((s) => [s.key, s]));

// ── Pools (der Picker) ────────────────────────────────────────────────────────
// Nur Pools, in denen tatsächlich Shops liegen — mit Anzahl fürs Label.
function pools() {
  return POOL_ORDER
    .map((k) => ({ key: k, ...POOL_META[k], count: SITES.filter((s) => s.pools.includes(k)).length }))
    .filter((p) => p.count > 0);
}
function sitesInPool(pool) { return SITES.filter((s) => s.pools.includes(pool)); }

// ── Kategorien (nur noch Metadata / Doku — nicht mehr im Picker) ──────────────
const CATEGORY_ORDER = ['TCG', 'Collectibles', 'Sneaker', 'SneakerRetailer', 'Fashion', 'Tech', 'Marktplatz', 'Buch', 'Sonstige'];
function categories() {
  return CATEGORY_ORDER.filter((c) => SITES.some((s) => s.category === c))
    .map((c) => ({ key: c, count: SITES.filter((s) => s.category === c).length }));
}
function sitesInCategory(cat) { return SITES.filter((s) => s.category === cat); }

function kindsFor(selectedKeys) {
  const kinds = new Set();
  for (const k of selectedKeys) { const s = BY_KEY[k]; if (s) kinds.add(s.kind); }
  return [...kinds];
}

// Map a URL to the most specific supported site by domain.
const PRESET_DOMAINS = [...SHOPIFY_PRESETS, ...BROWSER_PRESETS, ...BOOK_PRESETS].map((p) => [p.domain, p.key]);
function siteForUrl(url) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch (_) { return 'shopify'; }
  // preset domains first (most specific): match the brand part of the domain so
  // asphaltgold.de and asphaltgold.com both route to the asphaltgold preset.
  for (const [domain, key] of PRESET_DOMAINS) {
    const brand = domain.replace(/^www\./, '').replace(/\.[a-z.]+$/, ''); // "asphaltgold.de" → "asphaltgold"
    if (brand.length >= 4 && host.includes(brand)) return key;
  }
  if (host.includes('tcgviert.')) return 'tcgviert';
  if (host.includes('feenturm.')) return 'feenturm';
  return 'shopify';
}

module.exports = {
  SITES, BY_KEY, kindsFor, siteForUrl,
  pools, sitesInPool, POOL_ORDER, POOL_META,
  categories, sitesInCategory
};
