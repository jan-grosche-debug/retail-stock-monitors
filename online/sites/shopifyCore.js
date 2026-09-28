// Shared, pure Shopify helpers used by BOTH the plain-HTTP Shopify adapter
// (sites/shopify.js, via cycletls) and the browser-based one (used by Topps and
// Farmers, which sit behind Cloudflare). No I/O here — callers pass in the JSON
// they fetched however they could reach it.
//
// Shopify endpoints these helpers understand:
//   /search/suggest.json?q=<EAN|term>   → resolve an EAN/term to a product handle
//   /products/<handle>.js               → full product incl. variants
//                                          (variant.available, .price [cents],
//                                           .barcode [EAN], .sku)

function normDomain(d) {
  return String(d || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
}

function handleFromUrl(url) {
  const m = String(url || '').match(/\/products\/([^/?#]+)/);
  return m ? m[1] : null;
}

// First product handle out of a /search/suggest.json payload.
function handleFromSuggest(json) {
  const products = json?.resources?.results?.products || [];
  if (!products.length) return null;
  const p = products[0];
  return p.handle || handleFromUrl(p.url);
}

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// Choose the relevant variants of a /products/<handle>.js product.
function pickVariants(product, { ean, variantSku } = {}) {
  const variants = product.variants || [];
  if (ean) {
    const byBarcode = variants.filter((v) => v.barcode && onlyDigits(v.barcode) === onlyDigits(ean));
    if (byBarcode.length) return byBarcode;
  }
  if (variantSku) {
    const bySku = variants.filter((v) => v.sku && v.sku === variantSku);
    if (bySku.length) return bySku;
  }
  return variants;
}

// Build a monitor snapshot from a /products/<handle>.js product object.
function snapshotFromProduct(product, { id, label, domain, handle, ean, variantSku, srcPrefix = 'shopify' }) {
  const variants = pickVariants(product, { ean, variantSku });
  const available = variants.some((v) => v.available);
  const availPrices = variants.filter((v) => v.available).map((v) => v.price);
  const allPrices = variants.map((v) => v.price);
  const cents = available ? Math.min(...availPrices) : Math.min(...allPrices);
  const price = Number.isFinite(cents) ? cents / 100 : null;

  let img = product.featured_image || product.images?.[0] || null;
  const image = img ? (String(img).startsWith('http') ? img : `https:${img}`) : null;

  return {
    id,
    name: label || product.title || handle,
    url: `https://${domain}/products/${handle}`,
    image,
    price,
    currency: 'EUR',
    available,
    sourceNote: `${srcPrefix}(${domain}) · ${variants.filter((v) => v.available).length}/${variants.length} Varianten verfügbar`
  };
}

function suggestPath(query) {
  return `/search/suggest.json?q=${encodeURIComponent(query)}`
    + `&resources[type]=product&resources[limit]=5&resources[options][unavailable_products]=show`;
}

module.exports = { normDomain, handleFromUrl, handleFromSuggest, pickVariants, snapshotFromProduct, suggestPath };
