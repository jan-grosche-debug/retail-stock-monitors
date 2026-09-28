// Shared puppeteer-stealth browser for the sites that sit behind JS bot-walls.
//
// Two launch modes (one instance each, lazily created):
//   • headless 'new'  → default. Enough for MediaMarkt/Saturn (DataDome) and
//                       plain consent walls.
//   • headful         → headless:false, a real window. Needed for sites whose
//                       Cloudflare *managed challenge* never clears headless
//                       (e.g. de.topps.com). This is the same approach AIOBot's
//                       own runners use (mediamarktRunner launches headless:false).
//
// Adapters that need the window pass { headful: true }.
//
// Bandwidth: every page blocks images/media/fonts (req interception) — stock and
// price come from HTML/JSON-LD/script, not assets — which cuts the proxy GB on
// rendered pages (idealo/Geizhals/etc.) by a large margin. Scripts are kept so
// Cloudflare/DataDome challenges still run.

const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const proxy = require('./proxy');
const { getProxy } = proxy;
puppeteer.use(StealthPlugin());

const browsers = { headless: null, headful: null }; // mode → Promise<Browser>
const BLOCK_TYPES = new Set(['image', 'media', 'font']);

function modeKey(headful) { return headful ? 'headful' : 'headless'; }

// Chrome bindet den Proxy beim LAUNCH (--proxy-server) — ein IP-Wechsel im
// laufenden Browser geht nicht. Also: aktuellen Exit abstrafen, Browser zu,
// warme Seiten verwerfen. Der nächste Launch zieht automatisch den nächsten
// gesunden Exit aus dem Pool (proxy.getProxy() überspringt Cooldowns).
async function rotateProxy(reason = '') {
  const cur = getProxy();
  if (!cur) return null;
  proxy.penalize(cur, reason);
  await shutdown();
  const next = getProxy();
  if (next && next.id !== cur.id) console.log(`  browser: Proxy-Wechsel ${cur.id} → ${next.id}`);
  return next;
}

async function getBrowser(headful = false) {
  const key = modeKey(headful);
  if (!browsers[key]) {
    const proxy = getProxy();
    browsers[key] = puppeteer.launch({
      headless: headful ? false : 'new',
      ignoreHTTPSErrors: true, // some target shops ship a mismatched/!SAN cert
      defaultViewport: headful ? null : { width: 1366, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=de-DE,de',
        ...(proxy ? [`--proxy-server=${proxy.chromeServer}`] : []),
        ...(headful ? ['--start-maximized'] : [])
      ]
    });
    if (proxy) console.log(`  browser(${key}): über Proxy ${proxy.chromeServer}`);
  }
  return browsers[key];
}

async function newPage({ headful = false } = {}) {
  const browser = await getBrowser(headful);
  const page = await browser.newPage();
  const proxy = getProxy();
  if (proxy && proxy.username) {
    await page.authenticate({ username: proxy.username, password: proxy.password || '' }).catch(() => null);
  }
  // Block heavy assets to save proxy bandwidth — keep document/script/xhr/fetch
  // so JS bot-challenges still execute and JSON endpoints still load.
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        if (BLOCK_TYPES.has(req.resourceType())) req.abort().catch(() => {});
        else req.continue().catch(() => {});
      } catch (_) { try { req.continue(); } catch (e) { /* already handled */ } }
    });
  } catch (_) { /* interception unavailable → run without it */ }
  await page.setExtraHTTPHeaders({ 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' });
  return page;
}

// Click the most common German cookie-consent buttons if present. Best-effort.
async function dismissConsent(page) {
  try {
    await page.evaluate(() => {
      const sel = [
        '[data-test="pwa-consent-layer-accept-all"]',
        '#onetrust-accept-btn-handler',
        'button[aria-label*="akzeptieren" i]'
      ];
      for (const s of sel) { const el = document.querySelector(s); if (el) { el.click(); return; } }
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const hit = btns.find((b) => /(alle\s*)?akzeptieren|zustimmen|einverstanden|accept all/i.test(b.innerText || ''));
      if (hit) hit.click();
    });
  } catch (_) { /* no banner — fine */ }
}

function isChallengeTitle(t) {
  const s = (t || '').toLowerCase();
  return s.includes('just a moment') || s.includes('attention required') || s.includes('ein moment') || s === '';
}

// Navigate and wait for a JS bot-challenge (Cloudflare "Just a moment…",
// DataDome) to clear. Polls the title because a managed Cloudflare challenge can
// take 10–40 s to resolve. Returns once the title is real or we time out.
async function gotoAndSettle(page, url, { timeout = 60000, settleMs = 1500, challengeWaitMs = 45000 } = {}) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await dismissConsent(page);
  const deadline = Date.now() + challengeWaitMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      if (t.includes('just a moment') || t.includes('attention required') || t.includes('ein moment')) return false;
      if (document.querySelector('script[type="application/ld+json"]')) return true;
      return (document.body?.innerText || '').length > 1500 && t.length > 0;
    }).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await new Promise((r) => setTimeout(r, settleMs));
  return resp;
}

// One warmed page per origin (per mode): navigating to the origin once lets
// Cloudflare / DataDome set their clearance cookies, after which same-origin
// in-page fetches to JSON endpoints succeed. We keep the page open and reuse it.
const originPages = new Map(); // `${mode}|${origin}` → Promise<page>

function originOf(url) { return new URL(url).origin; }

async function getWarmPage(origin, { headful = false } = {}) {
  const key = `${modeKey(headful)}|${origin}`;
  if (!originPages.has(key)) {
    originPages.set(key, (async () => {
      const page = await newPage({ headful });
      await gotoAndSettle(page, `${origin}/`, { timeout: 60000, settleMs: 2500 });
      return page;
    })());
  }
  return originPages.get(key);
}

// Fetch a same-origin JSON path from inside the (challenge-cleared) page.
async function fetchJsonInPage(origin, pathname, { retries = 3, headful = false } = {}) {
  const key = `${modeKey(headful)}|${origin}`;
  let page = await getWarmPage(origin, { headful });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await page.evaluate(async (p) => {
        try {
          const r = await fetch(p, { headers: { accept: 'application/json' } });
          return { status: r.status, text: await r.text() };
        } catch (e) { return { status: 0, text: '', err: String(e && e.message) }; }
      }, pathname);
    } catch (e) {
      originPages.delete(key);
      page = await getWarmPage(origin, { headful });
      continue;
    }
    const looksChallenged = res.status === 0 || res.status === 403 || res.status === 503
      || /<!DOCTYPE html|just a moment|cf-chl|challenge-platform/i.test(res.text.slice(0, 200));
    if (!looksChallenged) {
      try { return { status: res.status, json: JSON.parse(res.text) }; }
      catch (_) { return { status: res.status, json: null, text: res.text }; }
    }
    await gotoAndSettle(page, `${origin}/`, { timeout: 60000, settleMs: 3000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`in-page JSON fetch kept hitting the bot-wall: ${origin}${pathname}`);
}

async function shutdown() {
  originPages.clear();
  for (const key of Object.keys(browsers)) {
    const p = browsers[key];
    browsers[key] = null;
    if (p) { const b = await p.catch(() => null); if (b) await b.close().catch(() => null); }
  }
}

module.exports = { getBrowser, newPage, dismissConsent, gotoAndSettle, getWarmPage, fetchJsonInPage, originOf, isChallengeTitle, rotateProxy, shutdown };
