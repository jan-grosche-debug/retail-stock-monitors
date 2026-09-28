// Rossmann.de in-store stock fetcher.
//
// Endpoint discovered:
//   GET https://www.rossmann.de/storefinder/.rest/store?dan={DAN}&q={PLZ}
//   Response: { store: [ { id, postcode, city, street, productInfo: [ { dan, stock, available } ] }, ... ] }
//
// Two complications vs. Galeria:
//   1. The endpoint takes Rossmann's internal "DAN" article number, not
//      the EAN. We resolve EAN→DAN by reading the PDP HTML and pulling
//      `data-product-id="..."` from the add-to-cart button. DAN is
//      cached after first resolution.
//   2. Rossmann sits behind a JS-based bot challenge (FastShield), so a
//      plain HTTP fetch returns a 3 KB challenge page. We use a Puppeteer
//      browser to keep a valid session and call the endpoint via
//      `page.evaluate(fetch(...))` so it inherits the browser's cookies +
//      challenge tokens.
//
// PLZ-Filter:
//   Each EAN entry can supply `plzPrefixes: ["481", "53", "50"]`. The
//   storefinder takes one query at a time, so we issue one call per
//   prefix using a representative PLZ from that range, then filter the
//   results client-side to stores whose postcode startsWith any prefix.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE = 'https://www.rossmann.de';
const DAN_CACHE_FILE = path.join(__dirname, 'rossmann-dan-cache.json');

// Representative PLZs to seed each prefix. The storefinder returns
// the closest stores to a given query, so for a "481" prefix we hit
// e.g. 48143 (Münster). We then filter results client-side by prefix.
const PREFIX_REPRESENTATIVES = {
  '481': '48143',
  '53':  '53111',
  '50':  '50667'
};

let browserPromise = null;
let pagePromise = null;
const danCache = new Map(); // ean -> { dan, productName, productUrl, productImage }

// Load persistent DAN cache from disk so a restart doesn't lose mappings
// resolved from previously-available PDPs.
(function loadDanCache() {
  try {
    if (!fs.existsSync(DAN_CACHE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(DAN_CACHE_FILE, 'utf8'));
    for (const [ean, meta] of Object.entries(obj)) {
      if (meta && meta.dan) danCache.set(ean, meta);
    }
  } catch (_) { /* ignore */ }
})();

function persistDanCache() {
  const obj = {};
  for (const [ean, meta] of danCache.entries()) obj[ean] = meta;
  try {
    const tmp = `${DAN_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, DAN_CACHE_FILE);
  } catch (_) { /* ignore */ }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      defaultViewport: { width: 1366, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=de-DE,de']
    });
  }
  return browserPromise;
}

async function getPage() {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await getBrowser();
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9' });

      // Warmup: visit homepage so FastShield issues its session cookies.
      await page.goto(`${BASE}/de/`, { waitUntil: 'networkidle2', timeout: 60000 });
      const clicked = await page.evaluate(() => {
        const direct = document.querySelector('[data-testid="uc-accept-all-button"], #onetrust-accept-btn-handler');
        if (direct) { direct.click(); return true; }
        return false;
      });
      // The consent click can trigger script-driven navigation/XHR. Wait
      // for the page to fully settle before any subsequent page.evaluate
      // — otherwise we race "Execution context was destroyed".
      if (clicked) {
        await page.waitForNetworkIdle({ idleTime: 1500, timeout: 10000 }).catch(() => null);
      }
      await new Promise((r) => setTimeout(r, 1500));
      return page;
    })();
  }
  return pagePromise;
}

async function shutdown() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  pagePromise = null;
  if (b) await b.close().catch(() => null);
}

// Resolves the canonical PDP URL for an EAN. Rossmann's PDPs live at
// /de/{slug}/p/{ean}. We don't know the slug; tries multiple strategies.
// Critically: also verifies the loaded PDP's data-product-id2 (the EAN)
// matches the one we asked for — Rossmann's catchall sometimes serves a
// stale or unrelated PDP.
async function findPdpUrl(page, ean, debug = () => {}) {
  async function pdpEan() {
    return page.evaluate(() => {
      const el = document.querySelector('[data-product-id][data-product-id2]');
      return el ? el.getAttribute('data-product-id2') : null;
    });
  }

  // 1. /de/p/{ean} — direct attempt
  await page.goto(`${BASE}/de/p/${ean}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  let loadedEan = await pdpEan();
  debug(`/de/p/${ean} → loaded ean=${loadedEan}, url=${page.url()}`);
  if (loadedEan === ean) return page.url();

  // 2. Site-search variants
  for (const searchUrl of [
    `${BASE}/de/suche?text=${encodeURIComponent(ean)}`,
    `${BASE}/de/search?text=${encodeURIComponent(ean)}`,
    `${BASE}/de/suche/?q=${encodeURIComponent(ean)}`,
    `${BASE}/de/search/?q=${encodeURIComponent(ean)}`
  ]) {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1500));
    const found = await page.evaluate((wantedEan) => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      const exact = links.find((el) => el.getAttribute('href')?.endsWith(`/${wantedEan}`));
      return exact ? exact.href : null;
    }, ean);
    debug(`search ${searchUrl} → ${found || 'no match'}`);
    if (found) {
      await page.goto(found, { waitUntil: 'domcontentloaded', timeout: 30000 });
      loadedEan = await pdpEan();
      debug(`  → loaded ean=${loadedEan}`);
      if (loadedEan === ean) return page.url();
    }
  }
  return null;
}

async function resolveEanMeta(page, ean, explicitUrl, logger) {
  if (danCache.has(ean)) return danCache.get(ean);

  let pdpUrl = null;
  if (explicitUrl) {
    await page.goto(explicitUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    const ok = await page.evaluate(() => !!document.querySelector('[data-product-id][data-product-id2]'));
    if (ok) pdpUrl = page.url();
  }
  if (!pdpUrl) pdpUrl = await findPdpUrl(page, ean, logger);
  if (!pdpUrl) return null;

  const meta = await page.evaluate(() => {
    // DAN sits on the add-to-cart button as data-product-id.
    const atc = document.querySelector('[data-product-id][data-product-id2]');
    const dan = atc?.getAttribute('data-product-id') || null;
    const ean = atc?.getAttribute('data-product-id2') || null;
    const name = atc?.getAttribute('data-product-name') ||
      document.querySelector('h1')?.innerText?.trim() || null;
    const image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
    return { dan, ean, name, image };
  });

  if (!meta.dan) return null;
  const result = {
    dan: meta.dan,
    productName: meta.name || `EAN ${ean}`,
    productUrl: pdpUrl,
    productImage: meta.image
  };
  danCache.set(ean, result);
  persistDanCache();
  return result;
}

async function fetchStoresForDan(page, dan, plz, pdpUrl) {
  // Browser-context fetch inherits FastShield cookies + UA.
  // Retry once on "Execution context destroyed" — happens if a redirect
  // races our evaluate after the consent click.
  const url = `${BASE}/storefinder/.rest/store?dan=${encodeURIComponent(dan)}&q=${encodeURIComponent(plz)}`;
  const referer = pdpUrl || `${BASE}/de/`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const json = await page.evaluate(async (u, r) => {
        const res = await fetch(u, {
          method: 'GET',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/javascript, */*; q=0.01',
            'x-requested-with': 'XMLHttpRequest'
          },
          referrer: r
        });
        if (!res.ok) return { __error: `HTTP ${res.status}` };
        try { return await res.json(); }
        catch (e) { return { __error: `parse: ${e.message}` }; }
      }, url, referer);
      if (!json || json.__error) return [];
      return Array.isArray(json.store) ? json.store : [];
    } catch (err) {
      const transient = /Execution context was destroyed|Target closed|detached Frame/i.test(err.message);
      if (!transient || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

function normalizeStoreEntry(s) {
  const info = (s.productInfo || [])[0] || {};
  return {
    id: s.id,
    postcode: s.postcode,
    city: s.city,
    street: s.street,
    name: `ROSSMANN ${s.city || ''} ${s.street || ''}`.replace(/\s+/g, ' ').trim(),
    stock: Number(info.stock) || 0,
    available: info.available === true
  };
}

async function fetchEanSnapshot(entry) {
  const ean = String(entry.ean || '').trim();
  if (!ean) throw new Error('entry.ean is required');
  const log = entry._log || (() => {});
  const plzPrefixes = entry.plzPrefixes && entry.plzPrefixes.length
    ? entry.plzPrefixes.map(String)
    : Object.keys(PREFIX_REPRESENTATIVES);

  // DAN-Auflösung in dieser Reihenfolge:
  //   1. Aus dem Config-Eintrag selbst (entry.dan)
  //   2. Aus dem persistenten Cache (rossmann-dan-cache.json)
  //   3. Aus der PDP per Browser-Resolve (nur wenn Produkt online verfügbar)
  let meta = null;
  if (entry.dan) {
    meta = {
      dan: String(entry.dan),
      productName: entry.label || `EAN ${ean}`,
      productUrl: entry.rossmannProductUrl || `${BASE}/de/p/${ean}`,
      productImage: null
    };
    danCache.set(ean, meta);
    persistDanCache();
    log(`[rossmann ${ean}] DAN aus Config=${meta.dan}`);
  } else if (danCache.has(ean)) {
    meta = danCache.get(ean);
    log(`[rossmann ${ean}] DAN aus Cache=${meta.dan}`);
  } else {
    log(`[rossmann ${ean}] open page + resolve EAN → DAN`);
    const page = await getPage();
    meta = await resolveEanMeta(page, ean, entry.rossmannProductUrl || entry.productUrl, log);
    if (meta) log(`[rossmann ${ean}] DAN aus PDP=${meta.dan}`);
  }

  if (!meta || !meta.dan) {
    // Mark snapshot with __danUnresolved so the scheduler can use a
    // shorter interval (every 30 min instead of 12 h) — we want to catch
    // the next moment the PDP comes back online.
    return {
      ean,
      productName: entry.label || `EAN ${ean}`,
      productUrl: `${BASE}/de/search?text=${encodeURIComponent(ean)}`,
      productImage: null,
      stores: [],
      sourceNote: 'DAN unbekannt — wartet auf nächstes PDP-Sichten',
      __danUnresolved: true
    };
  }

  // Storefinder-Calls brauchen das Browser-Page-Objekt (FastShield-
  // Session). Falls DAN aus Cache/Config kam, holen wir die Page jetzt.
  const page = await getPage();

  // For each PLZ prefix the user wants, query the storefinder with a
  // representative PLZ from that range, then merge + dedupe.
  const seen = new Map();
  for (const prefix of plzPrefixes) {
    const repPlz = PREFIX_REPRESENTATIVES[prefix] || prefix;
    log(`[rossmann ${ean}] fetch stores prefix=${prefix} (q=${repPlz})`);
    const stores = await fetchStoresForDan(page, meta.dan, repPlz, meta.productUrl);
    for (const raw of stores) {
      const s = normalizeStoreEntry(raw);
      if (!s.postcode) continue;
      if (!plzPrefixes.some((p) => s.postcode.startsWith(p))) continue;
      if (!s.available || s.stock <= 0) continue;
      if (seen.has(s.id)) continue;
      seen.set(s.id, s);
    }
  }

  const stores = [...seen.values()].sort((a, b) => a.postcode.localeCompare(b.postcode));
  return {
    ean,
    productName: meta.productName || entry.label || ean,
    productUrl: meta.productUrl,
    productImage: meta.productImage,
    stores,
    sourceNote: `rossmann storefinder • ${stores.length} Filialen mit Bestand`
  };
}

module.exports = { fetchEanSnapshot, shutdown, _internal: { resolveEanMeta, fetchStoresForDan } };
