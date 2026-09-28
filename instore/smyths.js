// Smyths Toys in-store stock fetcher.
//
// Endpoint discovered:
//   GET /api/de/de-de/store-pickup/pointOfServices
//     ?productId={ID}
//     &selectedStore=Köln%20Marsdorf
//     &latitude=0&longitude=0
//     &searchThroughGeoPointFirst=false
//     &cartPage=false
//   Headers: x-smyths-site-id: de, x-smyths-request-id: <UUID>
//   Returns: { stores: [{ name, town, id, line1, postalCode, stockStatusMessage, threshold, ... }] }
//   80 stores in one call. stockStatusMessage is "Nicht vorrätig" or
//   "{N} Auf Lager" or "15+ Auf Lager".
//
// Three complications:
//   1. productId, not EAN. Smyths' internal article number (e.g. 261550).
//      Same DAN-style mapping as Rossmann: read from PDP HTML or set manually
//      in the config (`smythsProductId: "261550"`). Cached to disk.
//   2. Imperva Incapsula bot protection on the HTML pages — but the API
//      endpoint accepts the user's pre-issued cookies. We DO NOT try to
//      fetch HTML; we only call the JSON API.
//   3. Cookies expire. Stored in smyths-cookies.json; user has to refresh
//      every few weeks (export from browser DevTools → Cookies tab).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createRequestClient } = require(path.join(__dirname, '..', 'lib', 'requestClient'));

const BASE = 'https://www.smythstoys.com';
const COOKIES_FILE = path.join(__dirname, 'smyths-cookies.json');
const PRODUCT_ID_CACHE = path.join(__dirname, 'smyths-productid-cache.json');

let sharedClient = null;
let cookieHeader = null;
const productIdCache = new Map();

(function loadProductIdCache() {
  try {
    if (!fs.existsSync(PRODUCT_ID_CACHE)) return;
    const obj = JSON.parse(fs.readFileSync(PRODUCT_ID_CACHE, 'utf8'));
    for (const [ean, meta] of Object.entries(obj)) {
      if (meta && meta.productId) productIdCache.set(ean, meta);
    }
  } catch (_) { /* ignore */ }
})();

function persistProductIdCache() {
  const obj = {};
  for (const [ean, meta] of productIdCache.entries()) obj[ean] = meta;
  try {
    const tmp = `${PRODUCT_ID_CACHE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, PRODUCT_ID_CACHE);
  } catch (_) { /* ignore */ }
}

function loadCookieHeader() {
  if (cookieHeader !== null) return cookieHeader;
  if (!fs.existsSync(COOKIES_FILE)) {
    cookieHeader = '';
    return '';
  }
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    cookieHeader = '';
  }
  return cookieHeader;
}

function getClient() {
  if (!sharedClient) sharedClient = createRequestClient({ useTls: true, timeout: 25000 });
  return sharedClient;
}

function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function apiHeaders(productId) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    accept: '*/*',
    'accept-language': 'de-DE,de;q=0.9,en-US;q=0.8',
    referer: `${BASE}/de/de-de/p/${productId}`,
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

// Stock string → numeric stock count.
// "Nicht vorrätig" → 0
// "15+ Auf Lager"  → 15 (treated as min threshold)
// "7 Auf Lager"    → 7
function parseStockCount(msg) {
  if (!msg) return 0;
  const lower = msg.toLowerCase();
  if (/nicht\s*vorr/i.test(lower) || /sold\s*out/i.test(lower)) return 0;
  const m = msg.match(/(\d+)\+?\s*auf\s*lager/i);
  if (m) return parseInt(m[1], 10);
  return 0;
}

async function fetchAllStoresForProductId(productId) {
  const client = getClient();
  const url = `${BASE}/api/de/de-de/store-pickup/pointOfServices`
    + `?productId=${encodeURIComponent(productId)}`
    + `&selectedStore=${encodeURIComponent('Köln Marsdorf')}`
    + `&latitude=0&longitude=0&searchThroughGeoPointFirst=false&cartPage=false`;
  const res = await client.get(url, { headers: apiHeaders(productId) });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Smyths API ${res.status} — cookies abgelaufen, smyths-cookies.json refreshen`);
  }
  if (res.status >= 400) throw new Error(`Smyths API ${res.status}`);

  let parsed;
  try { parsed = JSON.parse(res.data); }
  catch (e) { throw new Error(`Smyths API: invalid JSON (${e.message})`); }

  if (!Array.isArray(parsed.stores)) return [];
  return parsed.stores;
}

async function resolveProductIdMeta(ean, entry) {
  if (productIdCache.has(ean)) return productIdCache.get(ean);
  if (entry.smythsProductId) {
    const meta = {
      productId: String(entry.smythsProductId),
      productName: entry.label || `EAN ${ean}`,
      productUrl: `${BASE}/de/de-de/p/${entry.smythsProductId}`,
      productImage: null
    };
    productIdCache.set(ean, meta);
    persistProductIdCache();
    return meta;
  }
  return null;
}

async function fetchEanSnapshot(entry) {
  const ean = String(entry.ean || '').trim();
  if (!ean) throw new Error('entry.ean is required');
  const log = entry._log || (() => {});
  const plzPrefixes = entry.plzPrefixes && entry.plzPrefixes.length
    ? entry.plzPrefixes.map(String)
    : null; // null → keep all stores

  const meta = await resolveProductIdMeta(ean, entry);
  if (!meta) {
    return {
      ean,
      productName: entry.label || `EAN ${ean}`,
      productUrl: `${BASE}/de/de-de/`,
      productImage: null,
      stores: [],
      sourceNote: 'productId unbekannt — bitte einmal manuell finden (Smyths-PDP /p/<productId>) und als entry.smythsProductId im Config setzen',
      __danUnresolved: true // re-use index.js's faster-retry hook
    };
  }
  log(`[smyths ${ean}] productId=${meta.productId}`);

  const rawStores = await fetchAllStoresForProductId(meta.productId);
  log(`[smyths ${ean}] received ${rawStores.length} stores from API`);

  const filtered = [];
  const seen = new Set();
  for (const s of rawStores) {
    if (!s.postalCode) continue;
    if (plzPrefixes && !plzPrefixes.some((p) => String(s.postalCode).startsWith(p))) continue;
    const stock = parseStockCount(s.stockStatusMessage);
    if (stock <= 0) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    filtered.push({
      id: s.id,
      name: `Smyths ${s.name || s.town || ''}`.trim(),
      postcode: s.postalCode,
      stock,
      raw: s.stockStatusMessage
    });
  }
  filtered.sort((a, b) => String(a.postcode).localeCompare(String(b.postcode)));

  return {
    ean,
    productName: meta.productName,
    productUrl: meta.productUrl,
    productImage: meta.productImage,
    stores: filtered.map((s) => ({ name: `${s.name} (${s.postcode})` })),
    sourceNote: `smyths storefinder • ${filtered.length}/${rawStores.length} Filialen mit Bestand`
  };
}

async function shutdown() {
  sharedClient = null;
  cookieHeader = null;
  try {
    const { shutdownCycle } = require(path.join(__dirname, '..', 'lib', 'requestClient'));
    await shutdownCycle();
  } catch (_) { /* ignore */ }
}

module.exports = { fetchEanSnapshot, shutdown };
