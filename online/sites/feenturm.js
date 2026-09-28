// feenturm.de — TCG / tabletop shop on Shopify, reachable via cycletls (no
// browser). Thin preset over the generic Shopify adapter. EAN resolution works
// through the storefront search-page fallback.
//
//   { id, site: "feenturm", ean: "5713799100213" }
//   { id, site: "feenturm", url: "https://feenturm.de/products/<handle>" }
//   { id, site: "feenturm", handle: "<handle>" }

const shopify = require('./shopify');
const DOMAIN = 'feenturm.de';

module.exports = {
  fetch: (watch) => shopify.fetch({ ...watch, domain: watch.domain || DOMAIN, _srcPrefix: 'feenturm' }),
  DOMAIN
};
