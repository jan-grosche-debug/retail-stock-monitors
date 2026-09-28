// Puppeteer-based fetcher for Galeria.de.
//
// Why this is the primary path:
//   Galeria's storefront is a client-rendered Next.js SPA. The /suche/?q=
//   route returns a 200 HTML shell, but actual product list and the
//   "in Filiale prüfen" store widget are populated by XHR after JS runs.
//   A pure-HTTP fetcher therefore sees an empty shell. A real browser
//   sees the same data the user does.
//
// Single shared browser per process — launched lazily on first call,
// closed by the caller via shutdown(). One page is created per snapshot
// and disposed after; cookies persist via the browser context.

const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE = 'https://www.galeria.de';
const VIEWPORT = { width: 1366, height: 800 };

let browserPromise = null;
let acceptedConsent = false;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      defaultViewport: VIEWPORT,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=de-DE,de'
      ]
    });
  }
  return browserPromise;
}

async function shutdown() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  acceptedConsent = false;
  if (b) await b.close().catch(() => null);
}

async function dismissConsentIfPresent(page) {
  if (acceptedConsent) return;
  try {
    // Galeria uses Usercentrics. The accept button is reachable via shadow DOM.
    await page.waitForSelector('#usercentrics-root, [data-testid="uc-accept-all-button"]', { timeout: 4000 });
    const clicked = await page.evaluate(() => {
      const direct = document.querySelector('[data-testid="uc-accept-all-button"]');
      if (direct) { direct.click(); return true; }
      const root = document.querySelector('#usercentrics-root');
      if (root && root.shadowRoot) {
        const btn = root.shadowRoot.querySelector('[data-testid="uc-accept-all-button"]');
        if (btn) { btn.click(); return true; }
      }
      return false;
    });
    if (clicked) {
      acceptedConsent = true;
      await page.waitForTimeout?.(700) ?? new Promise((r) => setTimeout(r, 700));
    }
  } catch (_) { /* no consent banner — OK */ }
}

async function findProductFromSearch(page, ean) {
  // Galeria uses /produkt/{id} URLs. A search for an EAN typically either
  // 302's straight to /produkt/{ean} (if the EAN is also their product id)
  // or returns a search-results page with /produkt/... cards.
  await page.goto(`${BASE}/suche/?q=${encodeURIComponent(ean)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissConsentIfPresent(page);

  // If we're already on a /produkt/ URL, that's the product page itself.
  const finalUrl = page.url();
  if (/\/produkt\//i.test(finalUrl)) {
    const isNotFound = await page.evaluate(() =>
      /produkt wurde leider nicht gefunden|seite wurde leider nicht gefunden/i.test(document.body?.innerText || '')
    );
    return isNotFound ? null : finalUrl;
  }

  // Otherwise wait for a product card OR a "no results" indicator.
  await page.waitForFunction(() => {
    if (document.querySelector('a[href*="/produkt/"], a[href*="/p/"]')) return true;
    const t = (document.body?.innerText || '').toLowerCase();
    return t.includes('keine ergebnisse') || t.includes('keine treffer') || t.includes('nicht gefunden');
  }, { timeout: 15000 }).catch(() => null);

  const productUrl = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/produkt/"]') || document.querySelector('a[href*="/p/"]');
    if (!a) return null;
    const href = a.getAttribute('href');
    return href.startsWith('http') ? href : `https://www.galeria.de${href}`;
  });
  return productUrl;
}

async function extractFromPdp(page, productUrl) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissConsentIfPresent(page);

  // Pull the JSON-LD product schema for name/image. SSR'd, so available
  // immediately.
  const meta = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of scripts) {
      try {
        const parsed = JSON.parse(s.textContent || '');
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const it of list) {
          const types = Array.isArray(it?.['@type']) ? it['@type'] : [it?.['@type']];
          if (types.includes('Product')) {
            const img = Array.isArray(it.image) ? it.image[0] : it.image;
            return {
              name: it.name || null,
              image: typeof img === 'string' ? img : img?.url || null,
              url: it.url || null
            };
          }
        }
      } catch (_) { /* skip */ }
    }
    return { name: null, image: null, url: null };
  });

  // Try to open the store-finder widget. Galeria typically labels it
  // "In Filiale prüfen" or "In Filiale verfügbar".
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const target = buttons.find((el) => /in\s*filiale|in deiner filiale|verfügbarkeit\s*pr/i.test(el.innerText || el.textContent || ''));
    if (target) target.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Wait briefly for the store list to render. The structure varies between
  // Galeria's drops, so we try several DOM shapes.
  await page.waitForFunction(() => {
    const candidates = document.querySelectorAll('[data-testid*="store"], [data-test*="store"], [class*="store" i] li, [class*="storeRow" i], [class*="filiale" i]');
    return candidates.length > 0;
  }, { timeout: 7000 }).catch(() => null);

  const stores = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    const positiveMarkers = /(verfügbar|in[ -]?stock|auf lager|jetzt abholen|sofort|stk\.?\s*verfügbar|\d+\s*stk\.?)/i;
    const negativeMarkers = /(nicht verfügbar|ausverkauft|nicht auf lager)/i;
    const rows = document.querySelectorAll('[data-testid*="store" i], [data-test*="store" i], [class*="storeRow" i], [class*="store-row" i], [class*="filiale" i]');
    for (const row of rows) {
      const text = (row.innerText || row.textContent || '').trim();
      if (!text || text.length > 240) continue;
      const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const nameLine = lines.find((l) => /galeria|saturn|kaufhof|karstadt/i.test(l)) || lines[0];
      if (!nameLine || nameLine.length > 80) continue;
      const blob = text.toLowerCase();
      const stocked = positiveMarkers.test(blob) && !negativeMarkers.test(blob);
      if (!stocked) continue;
      const key = nameLine.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: nameLine });
    }
    return out;
  });

  return { meta, stores };
}

async function fetchEanSnapshotViaBrowser(entry) {
  const ean = String(entry.ean || '').trim();
  if (!ean) throw new Error('entry.ean is required');
  const log = entry._log || (() => {});
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' });

  try {
    let productUrl = entry.productUrl || null;
    if (!productUrl) {
      log(`[${ean}] open search`);
      productUrl = await findProductFromSearch(page, ean);
      log(`[${ean}] search → ${productUrl || 'none'}`);
    }
    if (!productUrl) {
      return {
        ean,
        productName: entry.label || ean,
        productUrl: `${BASE}/suche/?q=${encodeURIComponent(ean)}`,
        productImage: null,
        stores: [],
        sourceNote: 'product not found in search'
      };
    }

    log(`[${ean}] open PDP`);
    const { meta, stores } = await extractFromPdp(page, productUrl);
    log(`[${ean}] PDP done — ${stores.length} stores`);

    return {
      ean,
      productName: meta.name || entry.label || ean,
      productUrl: meta.url || productUrl,
      productImage: meta.image || null,
      stores,
      sourceNote: stores.length ? 'rendered DOM' : 'store widget did not render — selector may need updating'
    };
  } finally {
    await page.close().catch(() => null);
  }
}

module.exports = { fetchEanSnapshotViaBrowser, shutdown };
