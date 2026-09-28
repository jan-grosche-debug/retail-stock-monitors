// Slash-command definitions, component/modal builders, and the input→watch
// parsing for the /add flow. Pure functions (no I/O, no Discord calls) so the
// parsing can be unit-tested.
//
// /add läuft über POOLS (tcg | sneaker-fashion | technik | preisvergleiche |
// random) statt über die alten 9 Kategorien. Ein Shop darf in mehreren Pools
// liegen (Alternate = technik + tcg) — die Zuordnung steht in sites/pools.js.
//
// Zwei Discord-Limits, an denen die alte Version scheiterte und die hier gelöst
// sind:
//   • Ein String-Select fasst max. 25 Optionen → Pools mit mehr Shops werden
//     SEITENWEISE angeboten (Auswahl sammelt sich über Seiten hinweg an).
//   • Eine custom_id darf max. 100 Zeichen haben → die gewählten Shop-Keys
//     werden NICHT mehr in die custom_id gepackt, sondern in der Session
//     gehalten (bot/index.js). Vorher riss das ab ~10 Shops ab.

const { SITES, BY_KEY, kindsFor, siteForUrl, pools, sitesInPool, POOL_META } = require('./catalog');

const PAGE_SIZE = 25; // Discord: max. 25 Optionen pro String-Select

// ── Discord enums we use ──────────────────────────────────────────────────────
const CTYPE = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, CHANNEL_SELECT: 8 };
const TEXT_STYLE = { SHORT: 1, PARAGRAPH: 2 };
const ITYPE = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, MODAL_SUBMIT: 5 };
const FLAG_EPHEMERAL = 64;

// ── slash commands (registered on startup) ────────────────────────────────────
const COMMANDS = [
  { name: 'add', description: 'Produkt zum Monitor hinzufügen',
    options: [{ type: 1, name: 'product', description: 'Shops wählen, dann EAN/PID/URL + Max-Preis eingeben' }] },
  { name: 'list', description: 'Alle überwachten Produkte anzeigen' },
  { name: 'remove', description: 'Ein überwachtes Produkt löschen' },
  { name: 'pause', description: 'Ein Produkt pausieren (nicht löschen)' },
  { name: 'resume', description: 'Ein pausiertes Produkt wieder aktivieren' },
  { name: 'check', description: 'Sofort prüfen (ohne aufs Poll-Intervall zu warten)' },
  { name: 'interval', description: 'Poll-Intervall (Minuten) eines Produkts setzen' },
  { name: 'pricedrop', description: 'Preis-Drop-Alarm für ein Produkt ein-/ausschalten' },
  { name: 'channel', description: 'Ziel-Channel für die Alerts eines Produkts setzen' },
  { name: 'export', description: 'Komplette Watchlist als JSON exportieren' },
  { name: 'import', description: 'Watchlist aus JSON importieren (anhängen)' },
  { name: 'pools', description: 'Alle Seiten-Pools + welche Shops drin sind' }
];

// ── /add step 1: pool picker ───────────────────────────────────────────────────
function poolSelectMessage() {
  const options = pools().map((p) => ({
    label: `${p.label} (${p.count})`, value: p.key, description: clip(p.desc, 90), emoji: parseEmoji(p.emoji)
  }));
  return {
    flags: FLAG_EPHEMERAL,
    content: '🛒 **Produkt hinzufügen — Schritt 1/5**\nWähle einen Pool. _(Shops können in mehreren Pools liegen — z. B. Alternate in Technik **und** TCG.)_',
    components: [{
      type: CTYPE.ACTION_ROW,
      components: [{ type: CTYPE.STRING_SELECT, custom_id: 'add:pool', placeholder: 'Pool wählen…', min_values: 1, max_values: 1, options }]
    }]
  };
}

// ── /add step 2: shop multi-select (paginated, selection accumulates) ──────────
// `selected` = Set/Array der bereits (auf allen Seiten) gewählten Keys. Discord
// kann nur 25 Optionen zeigen → wir blättern und merken uns die Auswahl in der
// Session. `default: true` markiert bereits gewählte Shops der aktuellen Seite.
function pageCount(pool) {
  return Math.max(1, Math.ceil(sitesInPool(pool).length / PAGE_SIZE));
}

function siteSelectMessage(pool, page = 0, selected = []) {
  const all = sitesInPool(pool);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const sel = new Set(selected);
  const slice = all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const options = slice.map((s) => ({
    label: clip(s.label, 100),
    value: s.key,
    description: clip(s.hint, 90),
    emoji: parseEmoji(s.emoji),
    default: sel.has(s.key)
  }));

  const meta = POOL_META[pool] || { label: pool, emoji: '🛒' };
  const head = `🛒 **Schritt 2/5** — ${meta.emoji} **${meta.label}** · ${total} Shops`;
  const pageInfo = pages > 1 ? `\nSeite **${p + 1}/${pages}** _(Auswahl bleibt beim Blättern erhalten)_` : '';
  const chosen = sel.size ? `\n✅ Gewählt: **${sel.size}** — ${clip([...sel].map((k) => BY_KEY[k]?.label || k).join(', '), 220)}` : '';

  const rows = [{
    type: CTYPE.ACTION_ROW,
    components: [{
      type: CTYPE.STRING_SELECT, custom_id: 'add:sites',
      placeholder: 'Seite(n) wählen…', min_values: 0, max_values: options.length, options
    }]
  }];

  const nav = [];
  if (pages > 1) {
    nav.push(button('add:page:prev', '◀︎ Zurück', 2));
    nav.push(button('add:page:next', 'Weiter ▶︎', 2));
  }
  nav.push(button('add:all', `✅ Alle ${total} im Pool`, 2));
  rows.push({ type: CTYPE.ACTION_ROW, components: nav });
  rows.push({
    type: CTYPE.ACTION_ROW,
    components: [
      button('add:next', sel.size ? `➡️ Weiter mit ${sel.size} Shop(s)` : '➡️ Weiter', 1),
      button('add:cancel', '✖️ Abbrechen', 4)
    ]
  });

  return { flags: FLAG_EPHEMERAL, content: head + pageInfo + chosen, components: rows };
}

// ── /add step 3: choose single vs. multiple (comma-separated) ──────────────────
// Die Keys stecken NICHT mehr in der custom_id (100-Zeichen-Limit) — sie liegen
// in der Session.
function modeChoiceMessage(selectedKeys) {
  const kinds = kindsFor(selectedKeys);
  const single = kinds.length === 1;
  const what = single && kinds[0] === 'pid' ? 'PID' : single && kinds[0] === 'url' ? 'URL'
    : single && kinds[0] === 'asin' ? 'ASIN' : single && kinds[0] === 'query' ? 'GPU-Modell' : 'EAN';
  const shops = clip(selectedKeys.map((k) => BY_KEY[k]?.label || k).join(', '), 300);
  return {
    flags: FLAG_EPHEMERAL,
    content: `🛒 **Schritt 3/5** — ein Produkt oder mehrere gleichzeitig?\n_Shops (${selectedKeys.length}): ${shops}_\n_Bei „Mehrere" gibst du die ${what}s mit Komma getrennt ein, danach die Max-Preise ebenfalls mit Komma (positionsweise)._`,
    components: [{
      type: CTYPE.ACTION_ROW,
      components: [
        button('add:mode:single', `① Einzeln (eine ${what})`, 1),
        button('add:mode:multi', '② Mehrere (mit Komma)', 2)
      ]
    }]
  };
}

// ── /pools: Übersicht, welcher Shop in welchem Pool liegt ──────────────────────
function poolsOverviewMessage() {
  const fields = pools().map((p) => {
    const list = sitesInPool(p.key);
    const walled = list.filter((s) => /Proxy/i.test(s.hint || '')).length;
    return {
      name: `${p.emoji} ${p.label} — ${p.count}`,
      value: clip(list.map((s) => s.label).join(' · '), 1000) + (walled ? `\n_${walled} davon proxy-pflichtig_` : '')
    };
  });
  const multi = SITES.filter((s) => s.pools.length > 1);
  return {
    flags: FLAG_EPHEMERAL,
    embeds: [{
      title: `🗂️ Seiten-Pools (${SITES.length} Shops)`,
      description: `Ein Shop kann in mehreren Pools liegen.\n**Mehrfach zugeordnet (${multi.length}):** ${clip(multi.map((s) => `${s.label} → ${s.pools.join('+')}`).join(' · '), 900)}`,
      fields,
      color: 0x5865f2
    }]
  };
}

// ── /add step 3: identifier modal (EAN/PID/ASIN/URL fields, NO price yet) ───────
function buildIdentModal(selectedKeys, mode) {
  const kinds = kindsFor(selectedKeys);
  const multi = mode === 'multi';
  const req = kinds.length === 1; // sole field → required
  const rows = [];

  const pidShops = selectedKeys.filter((k) => BY_KEY[k]?.kind === 'pid').map((k) => BY_KEY[k].label).join('/');
  const eanShops = selectedKeys.filter((k) => BY_KEY[k]?.kind === 'ean').map((k) => BY_KEY[k].label).join('/');

  if (kinds.includes('ean')) rows.push(input('ean', multi ? `EANs für ${eanShops} (mit Komma)` : `EAN für ${eanShops}`, multi ? '0196214131651, 0196214132498' : 'z. B. 0196214131651', req, TEXT_STYLE.SHORT));
  if (kinds.includes('pid')) rows.push(input('pid', multi ? `PIDs für ${pidShops} — NICHT die EAN!` : `PID für ${pidShops} — NICHT die EAN!`, multi ? '2953441, 2863188' : 'z. B. 2953441', req, TEXT_STYLE.SHORT));
  if (kinds.includes('asin')) rows.push(input('asin', multi ? 'Amazon-ASINs (mit Komma)' : 'Amazon-ASIN', multi ? 'B0D9DH68YP, B0XXXX' : 'z. B. B0D9DH68YP', req, TEXT_STYLE.SHORT));
  if (kinds.includes('query')) rows.push(input('query', multi ? 'GPU-Modelle (mit Komma)' : 'GPU-Modell (NVIDIA)', multi ? 'RTX 5090, RTX 5080' : 'z. B. RTX 5090', req, TEXT_STYLE.SHORT));
  if (kinds.includes('url')) rows.push(input('url', multi ? 'Produkt-URLs (mit Komma)' : 'Produkt-URL', multi ? 'url1, url2' : 'https://…', req, TEXT_STYLE.PARAGRAPH));

  // Keys stehen in der Session, NICHT in der custom_id (100-Zeichen-Limit).
  return {
    custom_id: `add:idmodal:${mode}`,
    title: clip(multi ? 'Schritt 4/5 — IDs eingeben' : 'Schritt 4/5 — ID eingeben', 45),
    components: rows
  };
}

// ── /add step 3.5: button to advance to the price modal (modal→modal verboten) ──
function priceStepMessage(mode, count) {
  return {
    flags: FLAG_EPHEMERAL,
    content: `✅ Erfasst (${count} ${count === 1 ? 'Eintrag' : 'Einträge'}). **Schritt 5/5** — jetzt die Max-Preise (optional).`,
    components: [{ type: CTYPE.ACTION_ROW, components: [
      button(`add:pricestep:${mode}`, '💶 Max-Preis(e) eingeben', 1),
      button('add:nopricestep', '⏭️ Ohne Preis (nur Restock)', 2)
    ] }]
  };
}

// ── /add step 4: price modal ────────────────────────────────────────────────────
function buildPriceModal(mode) {
  const multi = mode === 'multi';
  return {
    custom_id: 'add:pricemodal',
    title: 'Schritt 5/5 — Max-Preis(e)',
    components: [input('price',
      multi ? 'Max-Preise in € — pro Produkt, mit Komma' : 'Max-Preis in € (optional)',
      multi ? 'z. B. 40, 80   (1 Preis = für alle; leer = ohne)' : 'z. B. 40   (leer = nur Restock-Alert; Dezimal: 39.99)',
      false, TEXT_STYLE.SHORT)]
  };
}

function button(custom_id, label, style) {
  return { type: CTYPE.BUTTON, style, custom_id: clip(custom_id, 100), label: clip(label, 80) };
}

function input(id, label, placeholder, required, style) {
  return {
    type: CTYPE.ACTION_ROW,
    components: [{
      type: CTYPE.TEXT_INPUT, custom_id: id, style,
      label: clip(label, 45), placeholder: clip(placeholder, 100),
      required: !!required, max_length: style === TEXT_STYLE.PARAGRAPH ? 1000 : 200
    }]
  };
}

// ── watch picker (remove / pause / resume / check / interval / pricedrop / channel)
// Builds a string-select of existing watches. `customId` carries the action so
// the router knows what to do with the chosen watch id.
function watchSelectMessage(customId, content, watches, { includeAll = false } = {}) {
  let list = watches.slice(0, includeAll ? 24 : 25);
  const options = list.map((w) => ({
    label: clip(w.label || w.id, 100),
    value: w.id,
    description: clip(`${w.site}${w.maxPrice != null ? ` · ≤${w.maxPrice}€` : ''}${w.enabled === false ? ' · pausiert' : ''}`, 90)
  }));
  if (includeAll) options.unshift({ label: 'ALLE Produkte', value: '*', description: 'auf alle anwenden' });
  if (!options.length) {
    return { flags: FLAG_EPHEMERAL, content: '📭 Es sind noch keine Produkte konfiguriert. Nutze `/add`.' };
  }
  const note = watches.length > options.length ? `\n_(zeige ${options.length} von ${watches.length})_` : '';
  return {
    flags: FLAG_EPHEMERAL,
    content: content + note,
    components: [{ type: CTYPE.ACTION_ROW, components: [{ type: CTYPE.STRING_SELECT, custom_id: customId, placeholder: 'Produkt wählen…', min_values: 1, max_values: 1, options }] }]
  };
}

// Channel picker for /channel (after a watch was chosen). customId carries the
// watch id: "channel:set:<watchId>".
function channelSelectMessage(watchId) {
  return {
    flags: FLAG_EPHEMERAL,
    content: '📣 In welchen Channel sollen die Alerts dieses Produkts gehen?',
    components: [{ type: CTYPE.ACTION_ROW, components: [{ type: CTYPE.CHANNEL_SELECT, custom_id: `channel:set:${watchId}`, placeholder: 'Channel wählen…', channel_types: [0, 5], min_values: 1, max_values: 1 }] }]
  };
}

function buildIntervalModal(watchId, current) {
  return {
    custom_id: `interval:modal:${watchId}`, title: 'Poll-Intervall setzen',
    components: [input('minutes', 'Intervall in Minuten', `aktuell: ${current ?? 'Standard'} — z. B. 5`, true, TEXT_STYLE.SHORT)]
  };
}

function buildPriceDropModal(watchId, current) {
  return {
    custom_id: `pricedrop:modal:${watchId}`, title: 'Preis-Drop-Alarm',
    components: [input('percent', 'Mindest-Rabatt in % (0 oder leer = aus)', `aktuell: ${current ? current + '%' : 'aus'} — z. B. 20`, false, TEXT_STYLE.SHORT)]
  };
}

function buildImportModal() {
  return {
    custom_id: 'import:modal', title: 'Watchlist importieren',
    components: [input('json', 'JSON (Array von Watches oder {watches:[…]})', '[{"site":"idealo","ean":"…","maxPrice":40}]', true, TEXT_STYLE.PARAGRAPH)]
  };
}

// ── parsing helpers ────────────────────────────────────────────────────────────
function splitList(s) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean); }

// Prices are comma-separated; German decimals would clash with that, so decimals
// must use a dot (documented in the placeholder). "-", "x", "" → no cap.
function parsePrice(tok) {
  const t = String(tok || '').trim();
  if (!t || t === '-' || /^x$/i.test(t)) return null;
  const m = t.match(/\d+(?:[.,]\d+)?/); // first number, € / "EUR" / spaces ignored
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceFor(prices, i) {
  if (!prices.length) return null;
  if (prices.length === 1) return prices[0];
  return i < prices.length ? prices[i] : null;
}

// Build the watch partials from a modal submission. `inputs` = { ean, pid, asin,
// url, price } raw strings. Returns { partials, warnings }.
function buildWatchPartials(selectedKeys, inputs) {
  const prices = splitList(inputs.price).map(parsePrice);
  const partials = [];
  const warnings = [];

  const eanSites = selectedKeys.filter((k) => BY_KEY[k]?.kind === 'ean');
  const pidSites = selectedKeys.filter((k) => BY_KEY[k]?.kind === 'pid');
  const asinSites = selectedKeys.filter((k) => BY_KEY[k]?.kind === 'asin');

  const eans = splitList(inputs.ean);
  eans.forEach((ean, i) => {
    const cap = priceFor(prices, i);
    eanSites.forEach((site) => partials.push(mk(site, { ean }, cap, `${BY_KEY[site].label} EAN ${ean}`)));
  });

  const pids = splitList(inputs.pid);
  pids.forEach((pid, i) => {
    const cap = priceFor(prices, i);
    pidSites.forEach((site) => partials.push(mk(site, { pid }, cap, `${BY_KEY[site].label} PID ${pid}`)));
  });

  const asins = splitList(inputs.asin);
  asins.forEach((asin, i) => {
    const cap = priceFor(prices, i);
    asinSites.forEach((site) => partials.push(mk(site, { asin: asin.toUpperCase(), region: 'de' }, cap, `Amazon ${asin.toUpperCase()}`)));
  });

  // free-text query sites (e.g. NVIDIA Marketplace by GPU model)
  const querySites = selectedKeys.filter((k) => BY_KEY[k]?.kind === 'query');
  const queries = splitList(inputs.query);
  queries.forEach((q, i) => {
    const cap = priceFor(prices, i);
    querySites.forEach((site) => partials.push(mk(site, { gpu: q }, cap, `${BY_KEY[site].label} — ${q}`)));
  });

  // URLs route to a shop by domain regardless of which url-shops were ticked.
  const urls = splitList(inputs.url);
  urls.forEach((url, i) => {
    if (!/^https?:\/\//i.test(url)) { warnings.push(`URL ignoriert (kein http/https): ${clip(url, 60)}`); return; }
    const site = siteForUrl(url);
    const cap = priceFor(prices, i);
    partials.push(mk(site, { url }, cap, `${BY_KEY[site].label}`));
  });

  if (!partials.length) warnings.push('Keine gültige EAN/PID/ASIN/URL erkannt — nichts hinzugefügt.');
  return { partials, warnings };
}

function mk(site, ident, maxPrice, label) {
  const w = { site, label, ...ident };
  if (maxPrice != null) w.maxPrice = maxPrice;
  return w;
}

// ── misc ───────────────────────────────────────────────────────────────────────
function clip(s, n) { s = String(s == null ? '' : s); return s.length <= n ? s : `${s.slice(0, n - 1)}…`; }
function parseEmoji(e) { return e ? { name: e } : undefined; }

module.exports = {
  CTYPE, TEXT_STYLE, ITYPE, FLAG_EPHEMERAL, COMMANDS, PAGE_SIZE,
  poolSelectMessage, siteSelectMessage, pageCount, poolsOverviewMessage,
  modeChoiceMessage, buildIdentModal, priceStepMessage, buildPriceModal, buildWatchPartials,
  watchSelectMessage, channelSelectMessage, buildIntervalModal, buildPriceDropModal, buildImportModal,
  _internal: { splitList, parsePrice, priceFor, clip, kindsFor }
};
