// Generic Shopify ONLINE availability/price for OPEN storefronts (no bot wall).
//
// Works for any plain Shopify shop ("generally shopify sites"). For shops behind
// Cloudflare (Topps, Farmers) see sites/shopifyBrowser.js instead.
//
//   { id, site: "shopify", domain: "tradingtoys.de", ean: "0196214140189" }
//   { id, site: "shopify", domain: "tradingtoys.de", handle: "product-handle" }
//   { id, site: "shopify", url: "https://tradingtoys.de/products/the-handle" }
//   ...optionally variantSku to pin one variant.
//
// EAN resolution: Shopify's public products.json does NOT expose variant
// barcodes, so an EAN is resolved through the shop's predictive-search endpoint
// (/search/suggest.json), which indexes barcodes on most shops, to find the
// handle. We then read /products/<handle>.js whose variants DO carry barcode,
// available and price (cents). All over cycletls.

const http = require('../http');
const core = require('./shopifyCore');

function domainOf(watch) {
  if (watch.domain) return core.normDomain(watch.domain);
  if (watch.url) { try { return new URL(watch.url).host; } catch (_) { /* fall */ } }
  throw new Error(`shopify watch "${watch.id}" needs "domain" or "url"`);
}

// Does product <handle> actually carry this EAN as a variant barcode? Used to
// verify a search hit so we never alert on a fuzzy / wrong product.
async function barcodeMatches(domain, handle, ean) {
  try {
    const { json } = await http.getJson(`https://${domain}/products/${handle}.js`, { referer: `https://${domain}/` });
    const d = onlyDigits(ean);
    return (json?.variants || []).some((v) => v.barcode && onlyDigits(v.barcode) === d);
  } catch (_) { return false; }
}

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// Resolve an EAN to a product handle. Tries the predictive-search endpoint
// first (fast, works where barcodes are indexed in suggest), then falls back to
// the full storefront search page /search?q=<ean> (TCG shops like tcgviert /
// feenturm expose barcodes there but NOT in suggest.json). Every candidate is
// verified against the product's real variant barcode before we accept it.
async function handleFromEan(domain, ean) {
  // 1) predictive search
  try {
    const { json } = await http.getJson(`https://${domain}${core.suggestPath(ean)}`, { referer: `https://${domain}/` });
    const h = core.handleFromSuggest(json);
    if (h && await barcodeMatches(domain, h, ean)) return h;
  } catch (_) { /* fall through */ }
  // 2) full search page (HTML) → verify barcode on each candidate
  try {
    const { body } = await http.getText(`https://${domain}/search?q=${encodeURIComponent(ean)}&type=product`, { referer: `https://${domain}/` });
    const handles = [...new Set([...body.matchAll(/\/products\/([a-z0-9][a-z0-9\-]*)/gi)].map((m) => m[1]))].slice(0, 8);
    for (const h of handles) { if (await barcodeMatches(domain, h, ean)) return h; }
  } catch (_) { /* fall through */ }
  return null;
}

async function fetchOne(watch) {
  const domain = domainOf(watch);
  const srcPrefix = watch._srcPrefix || 'shopify';
  let handle = watch.handle || core.handleFromUrl(watch.url);
  if (!handle && watch.ean) handle = await handleFromEan(domain, watch.ean);
  if (!handle) {
    return { id: watch.id, name: watch.label || `${domain} ${watch.ean || ''}`.trim(), url: `https://${domain}/`, image: null, price: null, currency: 'EUR', available: false, sourceNote: `${srcPrefix}(${domain}) · EAN nicht gefunden` };
  }

  const { status, json } = await http.getJson(`https://${domain}/products/${handle}.js`, { referer: `https://${domain}/` });
  if (status >= 400 || !json || !json.variants) throw new Error(`shopify /products/${handle}.js HTTP ${status}`);

  return core.snapshotFromProduct(json, {
    id: watch.id, label: watch.label, domain, handle,
    ean: watch.ean, variantSku: watch.variantSku, srcPrefix
  });
}

module.exports = { fetch: fetchOne, _internal: { handleFromEan, barcodeMatches } };
