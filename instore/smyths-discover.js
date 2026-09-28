// Smyths Pokemon-Karten daily auto-discovery.
//
// Crawls Smyths' Pokemon-Karten category via the storefront API and
// writes every product (productId + name + image + URL) to
// smyths-discovered.json. The main monitor loop merges these with
// config.galeria.eans on every config reload, so newly added Pokemon
// products on Smyths are automatically picked up by the stock-check
// pipeline within minutes.
//
// Triggered automatically by index.js once every 24 h. On failure
// (typically expired cookies → 403), sends a Discord notification so
// the user knows to refresh smyths-cookies.json.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createRequestClient } = require(path.join(__dirname, '..', 'lib', 'requestClient'));

const BASE = 'https://www.smythstoys.com';
const COOKIES_FILE = path.join(__dirname, 'smyths-cookies.json');
const DISCOVERED_FILE = path.join(__dirname, 'smyths-discovered.json');

// Smyths' API is category-CODE based (not slug). SM10010120 is the
// "Pokémon" parent category — it contains 180+ products: figures,
// puzzles, video games, sleeves, AND the actual TCG products (boosters,
// top-trainer boxes, etc.). The dedicated "Pokemon-Karten" sub-category
// only contains sleeves/binders, so we use the parent and filter by
// product NAME for TCG-relevant keywords.
const CATEGORIES = [
  {
    code: 'SM10010120',
    label: 'Pokemon-TCG',
    nameFilter: /sammelkartenspiel|booster|top.?trainer|trainer.?box|boosterbundle|booster.?bundle|mini.?tin|tcg|kollektion.*ex|premium.?kollektion|illustration|surprise.?box|elite.?trainer|displaybox|booster.?display/i
  }
];

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function uuid() {
  const b = crypto.randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function loadCookieHeader() {
  if (!fs.existsSync(COOKIES_FILE)) return '';
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_) { return ''; }
}

function loadDiscovered() {
  if (!fs.existsSync(DISCOVERED_FILE)) return { discoveredAt: 0, products: {} };
  try { return JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8')); }
  catch (_) { return { discoveredAt: 0, products: {} }; }
}

function persistDiscovered(state) {
  const tmp = `${DISCOVERED_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DISCOVERED_FILE);
}

// Smyths returns products under `products.data[]`, each item has at least
// { code, name, url } plus images/price etc.
function extractProducts(parsed) {
  const data = parsed?.products?.data;
  if (!Array.isArray(data)) return [];
  return data.map((p) => ({
    productId: String(p.code || p.id || p.productId || ''),
    name: p.name || p.title || '',
    url: p.url || p.productUrl || null,
    image: (p.images && (p.images[0]?.url || p.images[0])) || p.image || p.imageUrl || null,
    ean: p.ean || p.gtin || p.barcode || null,
    price: p.price?.formattedValue || p.price?.value || p.priceValue || null
  })).filter((p) => p.productId);
}

function apiHeaders() {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36',
    accept: '*/*',
    'accept-language': 'de-DE,de;q=0.9',
    referer: `${BASE}/de/de-de/spielzeug/action-spielzeug/pokemon/c/SM10010120`,
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-smyths-site-id': 'de',
    'x-smyths-request-id': uuid(),
    cookie: loadCookieHeader()
  };
}

// Fetch all pages of a Smyths category. Smyths' API uses
// products.totalPages / products.page for pagination.
async function fetchCategoryAll(client, code) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE}/api/de/de-de/c/${code}?currentPage=${page}&pageSize=${PAGE_SIZE}`;
    const res = await client.get(url, { headers: apiHeaders() });
    if (res.status === 403) {
      throw new Error('403 — Smyths Cookies abgelaufen, smyths-cookies.json refreshen');
    }
    if (res.status === 410) {
      throw new Error('410 — Imperva Rate-Limit, später nochmal versuchen');
    }
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    let parsed;
    try { parsed = JSON.parse(res.data); }
    catch (e) { throw new Error(`invalid JSON (${e.message})`); }
    const products = extractProducts(parsed);
    all.push(...products);
    const totalPages = parsed?.products?.totalPages ?? 1;
    if (page + 1 >= totalPages) break;
    // Pace pagination so we don't trip rate-limits
    await new Promise((r) => setTimeout(r, 1500));
  }
  return all;
}

async function runDiscovery({ logger = console.log } = {}) {
  const client = createRequestClient({ useTls: true, timeout: 30000 });
  const state = loadDiscovered();
  const newlyAdded = [];
  const errors = [];

  for (const cat of CATEGORIES) {
    try {
      logger(`[discover] fetch c/${cat.code} (filter: name=${!!cat.nameFilter}, url=${!!cat.urlFilter})`);
      const products = await fetchCategoryAll(client, cat.code);
      let filtered = products;
      if (cat.urlFilter) filtered = filtered.filter((p) => cat.urlFilter.test(p.url || ''));
      if (cat.nameFilter) filtered = filtered.filter((p) => cat.nameFilter.test(p.name || ''));
      logger(`[discover] c/${cat.code} → ${products.length} total, ${filtered.length} after filter`);
      for (const p of filtered) {
        if (!state.products[p.productId]) {
          state.products[p.productId] = {
            ...p,
            category: cat.label,
            firstSeenAt: Date.now()
          };
          newlyAdded.push(state.products[p.productId]);
        } else {
          Object.assign(state.products[p.productId], {
            name: p.name,
            url: p.url,
            image: p.image,
            ean: p.ean,
            price: p.price
          });
        }
      }
    } catch (err) {
      logger(`[discover] c/${cat.code} FAILED: ${err.message}`);
      errors.push(`${cat.code}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  state.discoveredAt = Date.now();
  state.lastErrors = errors;
  persistDiscovered(state);

  return {
    totalKnown: Object.keys(state.products).length,
    newlyAdded,
    errors
  };
}

module.exports = { runDiscovery, loadDiscovered };

// Standalone CLI: `node smyths-discover.js`
if (require.main === module) {
  runDiscovery({ logger: (m) => console.log(m) }).then((r) => {
    console.log(`\nDone. Total known: ${r.totalKnown}, newly added: ${r.newlyAdded.length}, errors: ${r.errors.length}`);
    if (r.newlyAdded.length) {
      console.log('Newly added:');
      for (const p of r.newlyAdded) console.log(`  ${p.productId} — ${p.name}`);
    }
    setTimeout(() => process.exit(0), 200).unref?.();
  }).catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
