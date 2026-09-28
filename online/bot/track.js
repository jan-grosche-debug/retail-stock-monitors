// EAN-first command layer — the friendly operation surface.
//
// Goal: feed ONE EAN and have it monitored across EVERY capable DACH shop with a
// single command. This module holds only PURE logic + the slash-command defs, so
// it is unit-testable without Discord/network. bot/index.js wires it to Discord.
//
//   /track   ean [maxpreis] [name] [gruppe]  → fan the EAN across all EAN-shops
//   /untrack ean                              → remove that EAN from all shops
//   /products                                 → watches grouped by product (EAN)
//
// "EAN-capable" = every catalog site whose kind === 'ean' PLUS Amazon (its ASIN is
// auto-resolved from the EAN by sites/eanAsin.js). Adding a shop to the catalog/
// presets automatically makes it part of every future /track.

const { SITES, BY_KEY } = require('./catalog');
const { POOL_ORDER, POOL_META } = require('../sites/pools');

const OPT = { STRING: 3, INTEGER: 4, NUMBER: 10 };

// Heavier sites (headless/headful browser and/or proxy-walled) poll less often by
// default → fewer requests on exactly the expensive sites (data-efficiency lever).
const HEAVY = new Set([
  'idealo', 'geizhals', 'billiger', 'amazon', 'topps', 'zalando', 'adidas',
  'mediamarkt', 'saturn', 'farmers', 'mueller', 'pagro', 'bstn', 'nike', '43einhalb'
]);
function defaultPollFor(key) { return HEAVY.has(key) ? 10 : 4; }

// ── slash-command definitions (merged with flow.COMMANDS in bot/index.js) ──────
// `gruppe` = Pool (sites/pools.js). „alle" fächert auf ALLE EAN-Shops auf.
const POOL_CHOICES = [
  { name: 'Alle EAN-Shops', value: 'alle' },
  ...POOL_ORDER.map((k) => ({ name: `Nur ${POOL_META[k].label}`, value: k }))
];

const EXTRA_COMMANDS = [
  {
    name: 'track',
    description: 'EAN auf allen passenden DACH-Shops überwachen (ein Befehl)',
    options: [
      { type: OPT.STRING, name: 'ean', description: 'EAN/GTIN des Produkts (8–14 Ziffern)', required: true },
      { type: OPT.NUMBER, name: 'maxpreis', description: 'Max-Preis in € — nur darunter alarmieren (optional)', required: false },
      { type: OPT.STRING, name: 'name', description: 'Anzeigename des Produkts (optional)', required: false },
      {
        type: OPT.STRING, name: 'gruppe', description: 'Nur ein Pool (Standard: alle)', required: false,
        choices: POOL_CHOICES
      }
    ]
  },
  {
    name: 'untrack',
    description: 'Eine EAN von allen Shops entfernen',
    options: [{ type: OPT.STRING, name: 'ean', description: 'Die zu entfernende EAN', required: true }]
  },
  { name: 'products', description: 'Überwachte Produkte – gruppiert nach EAN' }
];

// ── pure helpers ───────────────────────────────────────────────────────────────

// Normalise + validate an EAN/GTIN. Returns the digit string or null.
function validateEan(s) {
  const d = String(s == null ? '' : s).replace(/\D/g, '');
  return d.length >= 8 && d.length <= 14 ? d : null;
}

// All EAN-capable catalog sites, optionally limited to one POOL.
// Ein Shop kann in mehreren Pools liegen → `pools.includes(pool)` statt ===.
function eanCapableSites(group) {
  const g = String(group || 'alle').toLowerCase();
  return SITES.filter((s) => s.kind === 'ean' && (g === 'alle' || (s.pools || []).includes(g)));
}

// Does Amazon (EAN→ASIN) apply for this pool? Amazon führt praktisch alles →
// es liegt in mehreren Pools; wir richten uns nach genau dieser Zuordnung.
function amazonApplies(group) {
  if (!BY_KEY.amazon) return false; // Amazon adapter not part of this public version
  const g = String(group || 'alle').toLowerCase();
  if (g === 'alle') return true;
  return (BY_KEY.amazon?.pools || []).includes(g);
}

// Build the watch partials for one EAN fanned across all EAN-capable sites + Amazon.
// Returns { partials, sites } (sites = catalog-style entries it expanded to).
function buildEanPartials(ean, cap, name, group) {
  const catalogSites = eanCapableSites(group);
  const sites = catalogSites.slice();
  const base = name && String(name).trim() ? String(name).trim() : `EAN ${ean}`;
  const mk = (siteKey, siteLabel, extra) => {
    const p = { site: siteKey, ean, label: `${base} · ${siteLabel}`, ...extra };
    if (cap != null) p.maxPrice = cap;
    const poll = defaultPollFor(siteKey);
    if (poll) p.pollMinutes = poll;
    return p;
  };
  const partials = catalogSites.map((s) => mk(s.key, s.label));
  // Amazon via the EAN→ASIN converter (carries the EAN; adapter resolves the ASIN).
  if (amazonApplies(group)) {
    partials.push(mk('amazon', 'Amazon', { region: 'de' }));
    sites.push({ key: 'amazon', label: 'Amazon', kind: 'ean', category: 'Tech', pools: BY_KEY.amazon?.pools || ['technik'], viaConverter: true });
  }
  return { partials, sites };
}

// Group an existing watch list by product identifier (EAN/PID/ASIN/URL) so
// /products shows one row per product instead of one row per site.
function groupProducts(watches) {
  const map = new Map();
  for (const w of watches || []) {
    const ident = w.ean || w.pid || w.asin || w.url || '?';
    const kind = w.ean ? 'ean' : w.pid ? 'pid' : w.asin ? 'asin' : w.url ? 'url' : '?';
    const g = map.get(ident) || { ident, kind, label: '', sites: [], caps: [], anyEnabled: false };
    g.sites.push(w.site);
    g.caps.push(w.maxPrice == null ? null : w.maxPrice);
    if (w.enabled !== false) g.anyEnabled = true;
    if (!g.label && w.label) g.label = String(w.label).split(' · ')[0]; // strip the "· <Shop>" suffix
    map.set(ident, g);
  }
  return [...map.values()];
}

module.exports = {
  OPT, HEAVY, EXTRA_COMMANDS,
  defaultPollFor, validateEan, eanCapableSites, amazonApplies, buildEanPartials, groupProducts
};
