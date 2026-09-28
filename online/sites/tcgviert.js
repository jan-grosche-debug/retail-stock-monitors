// tcgviert.com — TCG shop on Shopify, reachable via cycletls (no browser).
// Thin preset over the generic Shopify adapter. EAN resolution works through the
// storefront search-page fallback (the shop doesn't index barcodes in suggest).
//
//   { id, site: "tcgviert", ean: "4050368984562" }
//   { id, site: "tcgviert", url: "https://tcgviert.com/products/<handle>" }
//   { id, site: "tcgviert", handle: "<handle>" }

const shopify = require('./shopify');
const DOMAIN = 'tcgviert.com';

module.exports = {
  fetch: (watch) => shopify.fetch({ ...watch, domain: watch.domain || DOMAIN, _srcPrefix: 'tcgviert' }),
  DOMAIN
};
