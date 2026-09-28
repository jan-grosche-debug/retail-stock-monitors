// Galeria.de in-store stock fetcher.
//
// Uses the same backend endpoint Galeria's own "Verfügbarkeit prüfen"
// widget calls:
//
//   POST https://www.galeria.de/services/storefinder/SuggestStoresWithAvailability
//   Content-Type: text/plain;charset=UTF-8
//   Body: ["<plz>", <radius_km>, "<ean>", 1]
//
// Response shape (top-level array):
//   [ [ {city, zip, location, ...} ],          // 0 = resolved input ZIP
//     [ { store: {...}, distance,
//         pickupAvailability?: { strategy: "clickAndReserve" | "clickAndCollect",
//                                pickupAvailable: bool, pickupFromDateTime },
//         deliveryAvailability?: {...} },
//       ...
//     ] ]                                      // 1 = stores
//
// We treat a store as having "in-store stock" only when
// pickupAvailability.strategy === 'clickAndReserve' && pickupAvailable === true
// — that strategy means the item is physically present in the branch, while
// clickAndCollect just means online order with branch pickup.
//
// Routes through AIOBot's requestClient so we get cycletls's Chrome JA3
// fingerprint; a plain Node fetch gets 403'd by the bot-protection layer.

const path = require('path');
const { createRequestClient } = require(path.join(__dirname, '..', 'lib', 'requestClient'));

const BASE = 'https://www.galeria.de';
const ENDPOINT = `${BASE}/services/storefinder/SuggestStoresWithAvailability`;
const DEFAULT_PLZ = '50667';     // Köln Hohe Straße — geographic center of GALERIA
const DEFAULT_RADIUS_KM = 9999;  // covers all 83 DE stores in one call

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'accept-language': 'de-DE,de;q=0.9',
  'content-type': 'text/plain;charset=UTF-8',
  origin: BASE,
  referer: `${BASE}/`,
  'sec-ch-ua': '"Chromium";v="127", "Google Chrome";v="127", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty'
};

// Per-process client. Cycletls keeps one Go process alive and reuses
// connections — much cheaper than spinning up a new client per EAN.
let sharedClient = null;
let warmedUp = false;

function getClient() {
  if (!sharedClient) sharedClient = createRequestClient({ useTls: true, timeout: 25000 });
  return sharedClient;
}

async function warmup(client) {
  if (warmedUp) return;
  await client.get(`${BASE}/`, {
    headers: {
      ...HEADERS,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'none'
    }
  }).catch(() => null);
  warmedUp = true;
}

async function callStorefinder(client, plz, ean, radius) {
  const body = JSON.stringify([String(plz), Number(radius), String(ean), 1]);
  const res = await client.post(ENDPOINT, { headers: HEADERS, data: body });
  if (res.status >= 400) {
    throw new Error(`storefinder ${ENDPOINT} → HTTP ${res.status}`);
  }
  let parsed;
  try { parsed = JSON.parse(res.data); }
  catch (err) { throw new Error(`storefinder response not JSON: ${err.message}`); }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('storefinder response shape unexpected');
  }
  const stores = Array.isArray(parsed[1]) ? parsed[1] : [];
  return stores;
}

function pickStockedStores(rawStores, mode = 'physical') {
  // mode === 'physical' → only entries flagged as physically present in the branch.
  // mode === 'any'      → also include click-and-collect availability.
  const out = [];
  for (const entry of rawStores) {
    const pa = entry.pickupAvailability;
    if (!pa) continue;
    const strategy = pa.strategy || '';
    const available = pa.pickupAvailable === true;
    if (!available) continue;
    if (mode === 'physical' && strategy !== 'clickAndReserve') continue;
    out.push({
      name: entry.store?.name || '(unbekannte Filiale)',
      city: entry.store?.city || '',
      zip: entry.store?.zip || '',
      strategy,
      pickupFrom: pa.pickupFromDateTime || null
    });
  }
  // Stable alphabetical order (de) for consistent diffs across cycles.
  out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return out;
}

// Best-effort product metadata from Bazaarvoice (Galeria publishes name +
// image there for every catalogued EAN). Falls back gracefully.
async function fetchProductMeta(client, ean) {
  const url = `https://apps.bazaarvoice.com/bfd/v1/clients/galeria/api-products/cv2/resources/data/products.json?locale=de_DE&allowMissing=true&apiVersion=5.4&filter=id%3A${encodeURIComponent(ean)}`;
  try {
    const res = await client.get(url, { headers: { ...HEADERS, accept: 'application/json' } });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.data);
    const item = data?.Results?.[0];
    if (!item) return null;
    return {
      name: item.Name || item.Brand?.Name || null,
      image: item.ImageUrl || null,
      productPageUrl: item.ProductPageUrl || null
    };
  } catch (_) { return null; }
}

async function fetchEanSnapshot(entry) {
  const ean = String(entry.ean || '').trim();
  if (!ean) throw new Error('entry.ean is required');
  const log = entry._log || (() => {});
  const plz = entry.plz || DEFAULT_PLZ;
  const radius = Number.isFinite(entry.radius) ? entry.radius : DEFAULT_RADIUS_KM;
  const mode = entry.includeClickAndCollect ? 'any' : 'physical';

  const client = getClient();
  log(`[${ean}] warmup`);
  await warmup(client);

  log(`[${ean}] storefinder POST plz=${plz} radius=${radius}`);
  const rawStores = await callStorefinder(client, plz, ean, radius);
  log(`[${ean}] received ${rawStores.length} stores from API`);

  const stores = pickStockedStores(rawStores, mode);
  log(`[${ean}] ${stores.length} with ${mode === 'physical' ? 'in-branch' : 'any-pickup'} stock`);

  const meta = await fetchProductMeta(client, ean);
  if (meta) log(`[${ean}] product meta: ${meta.name || '(no name)'}`);

  return {
    ean,
    productName: meta?.name || entry.label || ean,
    productUrl: meta?.productPageUrl
      ? (meta.productPageUrl.startsWith('http') ? meta.productPageUrl : `${BASE}${meta.productPageUrl}`)
      : `${BASE}/suche/?q=${encodeURIComponent(ean)}`,
    productImage: meta?.image || null,
    stores: stores.map((s) => ({ name: s.name })),
    sourceNote: `storefinder • ${stores.length}/${rawStores.length} Filialen mit Bestand`
  };
}

async function shutdownBrowser() {
  // Kept for index.js compatibility — we have no browser to close, but the
  // cycletls Go process needs to be shut down so the script can exit.
  warmedUp = false;
  sharedClient = null;
  try {
    const { shutdownCycle } = require(path.join(__dirname, '..', 'lib', 'requestClient'));
    await shutdownCycle();
  } catch (_) { /* ignore */ }
}

module.exports = { fetchEanSnapshot, shutdownBrowser };
