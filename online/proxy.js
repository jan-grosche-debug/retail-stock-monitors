// Proxy-Pool (ISP / Residential) mit Rotation + Health-Tracking.
//
// Vorher: EIN Proxy-String aus config.json. Jetzt: eine LISTE — weil ISP-Proxies
// üblicherweise als Block gekauft werden und ein einzelner geflaggter Exit sonst
// den ganzen Monitor lahmlegt.
//
// Quellen (in dieser Reihenfolge, alles wird zusammengeführt):
//   1) config.json  "proxies": ["http://u:p@host:port", "host:port:u:p", …]
//   2) config.json  "proxy":   "…"            (Alt-Format, weiterhin gültig)
//   3) proxies.txt  (eine Zeile pro Proxy, # = Kommentar)
//
// Akzeptierte Zeilenformate (das, was Proxy-Shops typischerweise ausliefern):
//   host:port:user:pass          ← Webshare/IPRoyal-Standard
//   user:pass@host:port
//   http://user:pass@host:port
//   host:port                    (ohne Auth)
//
// Auswahl (getProxyFor):
//   • STICKY pro Host — derselbe Shop bekommt denselben Exit. Wichtig, weil
//     Cloudflare/Imperva ihre Clearance-Cookies an die IP binden: rotiert man
//     mitten in der Session, ist die Challenge wieder da.
//   • Erst wenn ein Exit für diesen Host als blockiert gemeldet wird
//     (reportBlock), wandert der Host auf den nächsten gesunden Exit.
//   • Ein Exit, der zu oft blockt, geht in Cooldown (COOLDOWN_MS) und wird
//     solange übersprungen.
//
// Datenvolumen: ISP-Proxies sind GB-kontingentiert → NUR bot-gewallte Hosts
// gehen über den Proxy (useProxyForUrl). Billige Shopify-Shops laufen direkt.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PROXIES_TXT = path.join(__dirname, 'proxies.txt');

const COOLDOWN_MS = 10 * 60 * 1000; // wie lange ein geblockter Exit pausiert
const BLOCKS_TO_COOLDOWN = 2;        // so viele Blocks in Folge → Cooldown

let pool = null;      // Proxy[] | null  (null = noch nicht geladen)
const health = new Map();   // id → { ok, fail, blocks, cooldownUntil }
const stickyHost = new Map(); // host → proxy id

// ── Parsing ──────────────────────────────────────────────────────────────────
function parseOne(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') {
    if (!raw.server) return null;
    return normalize(raw.server, raw.username || null, raw.password || null);
  }
  let s = String(raw).trim();
  if (!s || s.startsWith('#')) return null;

  // host:port:user:pass  (kein "://", kein "@", genau 4 Teile)
  if (!s.includes('://') && !s.includes('@')) {
    const parts = s.split(':');
    if (parts.length === 4) return normalize(`http://${parts[0]}:${parts[1]}`, parts[2], parts[3]);
    if (parts.length === 2) return normalize(`http://${parts[0]}:${parts[1]}`, null, null);
    return null;
  }
  if (!s.includes('://')) s = `http://${s}`; // user:pass@host:port
  return normalize(s, null, null);
}

function normalize(server, user, pass) {
  let username = user;
  let password = pass;
  let chromeServer = server;
  try {
    const u = new URL(server.includes('://') ? server : `http://${server}`);
    if (u.username) username = decodeURIComponent(u.username);
    if (u.password) password = decodeURIComponent(u.password);
    chromeServer = `${u.protocol}//${u.host}`; // Chrome --proxy-server kann keine Creds tragen
    // Server MIT Creds für cycletls/axios:
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
    server = `${u.protocol}//${auth}${u.host}`;
  } catch (_) { return null; }
  const id = chromeServer.replace(/^https?:\/\//, '');
  return { id, server, chromeServer, username, password };
}

function readConfigProxies() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const list = [];
    if (Array.isArray(cfg.proxies)) list.push(...cfg.proxies);
    if (cfg.proxy) list.push(cfg.proxy);
    return list;
  } catch (_) { return []; }
}

function readTxtProxies() {
  try {
    return fs.readFileSync(PROXIES_TXT, 'utf8').split(/\r?\n/);
  } catch (_) { return []; }
}

function loadPool() {
  if (pool) return pool;
  const raw = [...readConfigProxies(), ...readTxtProxies()];
  const seen = new Set();
  pool = [];
  for (const r of raw) {
    const p = parseOne(r);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    health.set(p.id, { ok: 0, fail: 0, blocks: 0, cooldownUntil: 0 });
    pool.push(p);
  }
  if (pool.length) {
    console.log(`  proxy: ${pool.length} Proxy/Proxies geladen (${pool.map((p) => p.id).join(', ')})`);
  }
  return pool;
}

// ── Health ───────────────────────────────────────────────────────────────────
function healthOf(id) {
  if (!health.has(id)) health.set(id, { ok: 0, fail: 0, blocks: 0, cooldownUntil: 0 });
  return health.get(id);
}
function isHealthy(p) { return healthOf(p.id).cooldownUntil <= Date.now(); }

function healthyPool() {
  const all = loadPool();
  const ok = all.filter(isHealthy);
  return ok.length ? ok : all; // alle im Cooldown → trotzdem einen nehmen (besser als gar nichts)
}

// Erfolg auf diesem Exit → Block-Zähler zurücksetzen.
function reportSuccess(p) {
  if (!p) return;
  const h = healthOf(p.id);
  h.ok += 1;
  h.blocks = 0;
}

// Einen konkreten Exit abstrafen (Block-Zähler hoch; ab BLOCKS_TO_COOLDOWN in
// Cooldown). Wird von reportBlock (HTTP-Pfad) und browser.rotateProxy genutzt.
function penalize(p, reason = '') {
  if (!p) return;
  const st = healthOf(p.id);
  st.fail += 1;
  st.blocks += 1;
  if (st.blocks >= BLOCKS_TO_COOLDOWN) {
    st.cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(`  proxy: ${p.id} pausiert für ${COOLDOWN_MS / 60000} min (${st.blocks}× geblockt${reason ? ' — ' + reason : ''})`);
  }
}

// Der Exit hat für diesen Host eine Bot-Wall kassiert → Host auf den nächsten
// Exit umhängen; nach BLOCKS_TO_COOLDOWN Blocks in Folge den Exit pausieren.
function reportBlock(url, reason = '') {
  const h = hostOf(url);
  const p = h ? proxyById(stickyHost.get(h)) : null;
  if (!p) return null;
  penalize(p, reason);
  stickyHost.delete(h); // nächster Aufruf zieht einen neuen Exit für diesen Host
  const next = pickFor(h);
  if (next && next.id !== p.id) console.log(`  proxy: ${h} → wechsle auf ${next.id}`);
  return next;
}

function proxyById(id) { return id ? loadPool().find((p) => p.id === id) || null : null; }

// ── Auswahl ──────────────────────────────────────────────────────────────────
function hostOf(url) {
  try { return new URL(String(url).includes('://') ? url : `http://${url}`).host.toLowerCase(); }
  catch (_) { return ''; }
}

// Sticky pro Host, mit gleichmäßiger Verteilung über die gesunden Exits.
function pickFor(host) {
  const ok = healthyPool();
  if (!ok.length) return null;
  const cur = proxyById(stickyHost.get(host));
  if (cur && isHealthy(cur)) return cur;
  // wenig genutzten Exit bevorzugen → Last verteilt sich über den Pool
  const used = new Map();
  for (const id of stickyHost.values()) used.set(id, (used.get(id) || 0) + 1);
  const next = ok.slice().sort((a, b) => (used.get(a.id) || 0) - (used.get(b.id) || 0))[0];
  if (host) stickyHost.set(host, next.id);
  return next;
}

// Der Proxy für DIESE URL (oder null → direkt).
function getProxyFor(url) {
  if (!useProxyForUrl(url)) return null;
  return pickFor(hostOf(url));
}

// Rückwärtskompatibel: „der" aktive Proxy. browser.js startet Chrome mit genau
// einem --proxy-server, deshalb braucht es weiterhin einen Default-Exit.
function getProxy() {
  const ok = healthyPool();
  return ok.length ? ok[0] : null;
}

function hasProxies() { return loadPool().length > 0; }
function listProxies() { return loadPool().map((p) => ({ ...p, health: { ...healthOf(p.id) } })); }

// Nur für Tests/Neuladen nach Config-Änderung.
function reset() { pool = null; health.clear(); stickyHost.clear(); }

// ── Welche Hosts überhaupt über den (teuren) Proxy gehen ──────────────────────
const CORE_WALLED = [
  'idealo.', 'geizhals.', 'preisvergleich.', 'billiger.', 'guenstiger.', 'preis.de', 'check24.',
  'amazon.', 'farmers-shop.', 'topps.', 'adidas.', 'zalando.', 'mediamarkt.', 'saturn.',
  'mueller.', 'pagro.'
];

let walledBrands = null;
function loadWalledBrands() {
  if (walledBrands) return walledBrands;
  walledBrands = [];
  try {
    const { SHOPIFY_PRESETS, BROWSER_PRESETS, BOOK_PRESETS } = require('./sites/presets');
    for (const p of [...SHOPIFY_PRESETS, ...BROWSER_PRESETS, ...BOOK_PRESETS]) {
      if (p && p.walled && p.domain) {
        const brand = String(p.domain).replace(/^www\./, '').replace(/\.[a-z.]+$/, '');
        if (brand.length >= 4) walledBrands.push(brand.toLowerCase());
      }
    }
  } catch (_) { /* presets optional */ }
  return walledBrands;
}

function useProxyForUrl(url) {
  if (!hasProxies()) return false;              // kein Proxy konfiguriert → direkt
  const h = hostOf(url);
  if (!h) return true;                           // unbekannter Host → sicherheitshalber Proxy
  if (CORE_WALLED.some((s) => h.includes(s))) return true;
  for (const brand of loadWalledBrands()) if (h.includes(brand)) return true;
  return false;
}

module.exports = {
  getProxy, getProxyFor, useProxyForUrl,
  reportSuccess, reportBlock, penalize,
  hasProxies, listProxies, reset,
  _internal: { parseOne, normalize, pickFor, hostOf }
};
