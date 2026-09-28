// Shared HTTP helper for the sites we can reach without a browser (Alternate,
// Shopify, Amazon search/PDP). Routes through AIOBot's requestClient so we
// inherit cycletls's Chrome JA3 fingerprint, then falls back to axios. Also holds
// the price-parsing / JSON-LD helpers shared by several site modules.
//
// Two clients, picked per request URL (data-efficiency):
//   • DIRECT  → over the VPS IP, for cheap shops (no proxy GB used)
//   • PROXY   → over the residential/ISP proxy, ONLY for bot-walled hosts
// The choice is made by proxy.useProxyForUrl(url), so adapters need no changes.

const path = require('path');
const { createRequestClient, shutdownCycle } = require(path.join(__dirname, '..', 'lib', 'requestClient'));
const { getProxyFor, useProxyForUrl } = require('./proxy');

let clientDirect = null;
const clientsByProxy = new Map(); // proxy.id → requestClient (ein Client je Exit)

function getClient(proxy = null) {
  if (proxy) {
    if (!clientsByProxy.has(proxy.id)) {
      clientsByProxy.set(proxy.id, createRequestClient({ useTls: true, timeout: 20000, proxy: { server: proxy.server } }));
      console.log(`  http: Proxy-Client für ${proxy.id}`);
    }
    return clientsByProxy.get(proxy.id);
  }
  if (!clientDirect) clientDirect = createRequestClient({ useTls: true, timeout: 20000 });
  return clientDirect;
}

// Wählt den Exit pro URL (sticky pro Host, s. proxy.js). Nicht-gewallte Hosts
// laufen weiterhin direkt → kein GB-Verbrauch auf dem ISP-Kontingent.
async function getText(url, headers = {}) {
  const proxy = getProxyFor(url); // null → direkt
  const res = await getClient(proxy).get(url, { headers });
  return { status: res.status, body: String(res.data || ''), headers: res.headers || {}, proxy };
}

async function getJson(url, headers = {}) {
  const { status, body } = await getText(url, { accept: 'application/json', ...headers });
  let json = null;
  try { json = JSON.parse(body); } catch (_) { /* leave null */ }
  return { status, json, body };
}

async function shutdown() {
  await shutdownCycle().catch(() => null);
  clientDirect = null;
  clientsByProxy.clear();
}

// "8.99" | "8,99" | "1.299,00" | "€ 18,99" | 8.99 → 8.99 (Number) or null.
function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes('.') && s.includes(',')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Pull every JSON-LD blob off an HTML string, flattened (handles @graph/arrays).
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch (_) { continue; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of list) {
      if (node && Array.isArray(node['@graph'])) out.push(...node['@graph']);
      else out.push(node);
    }
  }
  return out;
}

function hasType(node, type) {
  const t = node && node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

// availability string → boolean. Accepts schema.org URLs and German text.
function availabilityToBool(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  if (/(^|\/)instock|in_stock|preorder|backorder|limitedavailability|auf lager|sofort|verfügbar|lieferbar/.test(s)) {
    // exclude explicit negations
    if (/nicht (verfügbar|lieferbar)|out_?of_?stock|outofstock|ausverkauft|soldout/.test(s)) return false;
    return true;
  }
  if (/out_?of_?stock|outofstock|ausverkauft|soldout|nicht verfügbar|nicht lieferbar|sold out|discontinued/.test(s)) return false;
  return null;
}

// Read price/availability/name/image from JSON-LD Product offers, if present.
function productFromJsonLd(html) {
  const product = extractJsonLd(html).find((n) => hasType(n, 'Product'));
  if (!product) return null;
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const price = offers ? parsePrice(offers.price ?? offers.lowPrice) : null;
  const currency = offers?.priceCurrency || 'EUR';
  const available = offers ? availabilityToBool(offers.availability) : null;
  let image = product.image;
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === 'object') image = image.url;
  return { name: product.name || null, price, currency, available, image: image || null };
}

module.exports = {
  getClient, getText, getJson, shutdown,
  parsePrice, extractJsonLd, hasType, availabilityToBool, productFromJsonLd
};
