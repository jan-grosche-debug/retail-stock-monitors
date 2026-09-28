// Online stock/price monitor.
//
// A config-driven polling loop that fetches each watched product from its shop,
// tracks state in state.json, and posts a Discord embed when something
// interesting happens. The primary signal is AVAILABILITY (a product becomes
// buyable, i.e. a restock or drop), with an optional price-drop signal per watch.
//
// Supported sites (watch.site):
//   "shopify"                → any Shopify shop by EAN/handle/url (cycletls)
//   "tcgviert" | "feenturm"  → Shopify shops with a fixed domain
//   <preset key>             → every row in sites/presets.js SHOPIFY_PRESETS
//
// Scheduling, backoff, state persistence and an alert cooldown keep request
// volume low and avoid duplicate pings.

const fs = require('fs');
const path = require('path');

const { DiscordClient, WebhookClient } = require('./discord');
const availability = require('./availability');
const browser = require('./browser');
const http = require('./http');
const status = require('./status');

const shopify = require('./sites/shopify');
const tcgviert = require('./sites/tcgviert');
const feenturm = require('./sites/feenturm');
const presets = require('./sites/presets');
const { startBot } = require('./bot');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');

const TICK_MS = 60 * 1000;
const MAX_EMBED_DESCRIPTION = 3500;

const argv = new Set(process.argv.slice(2));
const RUN_ONCE = argv.has('--once');
// Bot-only: run just the slash-command bot (no polling loop, no browser). Useful
// to run the command interface separately, or where the polling shop fetches
// can't run cleanly. /check still fetches on demand.
const BOT_ONLY = argv.has('--bot-only');

// ── site router ──────────────────────────────────────────────────────────────
const SITES = {
  shopify: (w) => shopify.fetch(w),
  tcgviert: (w) => tcgviert.fetch(w),
  feenturm: (w) => feenturm.fetch(w)
};

// Data-driven preset shops (sites/presets.js): Shopify presets route through the
// cycletls Shopify adapter with their domain; browser presets render the PDP.
for (const p of presets.SHOPIFY_PRESETS) {
  SITES[p.key] = (w) => shopify.fetch({ ...w, domain: w.domain || p.domain, _srcPrefix: p.key });
}

// Listing fetchers (return an ARRAY of product snapshots) for new-arrival
// monitors. Used when watch.kind === "listing".
const LISTINGS = {};
function listingFor(watch) {
  const key = String(watch.site || '').toLowerCase();
  if (!LISTINGS[key]) throw new Error(`No listing fetcher for site "${watch.site}" (watch ${watch.id})`);
  return LISTINGS[key];
}
function isListing(watch) { return String(watch.kind || '').toLowerCase() === 'listing'; }

// Per-watch hard timeout so one blocked site (e.g. a headful Akamai/Cloudflare
// challenge that never clears from this IP) can't hang the whole sequential run.
function watchTimeoutMs(config, watch) {
  return (watch.timeoutSeconds ?? config.defaults?.watchTimeoutSeconds ?? 90) * 1000;
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fetcherFor(watch) {
  const key = String(watch.site || '').toLowerCase();
  if (!SITES[key]) throw new Error(`Unknown site "${watch.site}" for watch ${watch.id}`);
  return SITES[key];
}

// ── config / state ───────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing ${CONFIG_PATH} — copy config.example.json and fill it in.`);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Delivery is either a Discord webhook URL (no bot needed) or a bot token +
  // target. Webhook takes precedence when set.
  if (!cfg.discord?.webhookUrl) {
    if (!cfg.discord?.botToken) { console.error('config.discord: set webhookUrl OR botToken.'); process.exit(2); }
    if (!cfg.discord?.target) { console.error('config.discord.target is required when using a bot token.'); process.exit(2); }
  }
  if (!Array.isArray(cfg.watches)) cfg.watches = [];
  return cfg;
}

// Re-read watches + defaults from config.json in place so the bot can add /
// remove / edit watches and have them take effect on the next tick without a
// restart. Tolerates a transient parse error (mid-write) by keeping the old set.
function reloadWatches(config) {
  try {
    const fresh = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (Array.isArray(fresh.watches)) config.watches = fresh.watches;
    if (fresh.defaults) config.defaults = fresh.defaults;
  } catch (_) { /* keep previous config this tick */ }
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) { return {}; }
}

function saveState(state) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function enabledWatches(config) {
  // When botWatchesOnly is set, only watches created via the Discord bot
  // (source:'bot') are polled/alerted; manually-configured watches stay dormant.
  const botOnly = config.defaults?.botWatchesOnly === true;
  return config.watches.filter((w) => w && w.enabled !== false && w.id && w.site && (!botOnly || w.source === 'bot'));
}

function pollMsFor(config, watch) {
  const minutes = watch.pollMinutes ?? config.defaults?.pollMinutes ?? 10;
  return minutes * 60 * 1000;
}

function errorBackoffMs(config, streak) {
  const base = (config.defaults?.errorBackoffMinutes ?? 15) * 60 * 1000;
  return base * Math.min(8, streak);
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtPrice(n, currency = 'EUR') {
  if (n == null) return '—';
  const sym = currency === 'EUR' ? '€' : (currency || '');
  return `${n.toFixed(2).replace('.', ',')} ${sym}`.trim();
}

function clip(text, max) { return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }

function buildEmbed({ snap, verdict, watch }) {
  const isDrop = verdict.reason && verdict.reason.startsWith('price-drop');
  const lines = [];
  let color;
  let icon;

  if (isDrop) {
    const drop = Math.round(verdict.dropPercent);
    icon = '💥';
    color = 0xeab308;
    lines.push(`💥 **−${drop}%**  ~~${fmtPrice(verdict.baseline, snap.currency)}~~ → **${fmtPrice(snap.price, snap.currency)}**`);
  } else if (verdict.reason === 'price-target') {
    icon = '🎯';
    color = 0x22c55e;
    const cap = verdict.maxPrice != null ? ` (≤ ${fmtPrice(verdict.maxPrice, snap.currency)})` : '';
    lines.push(`🎯 **Zielpreis & verfügbar** — **${fmtPrice(snap.price, snap.currency)}**${cap}`);
  } else {
    icon = verdict.reason === 'in-stock' ? '🟢' : '🔔';
    color = 0x22c55e;
    lines.push(`🟢 **Jetzt verfügbar** — ${fmtPrice(snap.price, snap.currency)}`);
  }
  if (snap.sourceNote) lines.push(`\`${snap.sourceNote}\``);

  const embed = {
    title: clip(`${icon} ${snap.name || snap.id}`, 240),
    url: snap.url,
    description: clip(lines.join('\n'), MAX_EMBED_DESCRIPTION),
    color,
    fields: [
      { name: 'Preis', value: fmtPrice(snap.price, snap.currency), inline: true },
      { name: 'Shop', value: String(watch.site), inline: true },
      { name: 'Status', value: isDrop ? `−${Math.round(verdict.dropPercent)}%` : 'verfügbar', inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `Online Monitor • ${verdict.reason}` }
  };
  if (snap.image) embed.thumbnail = { url: snap.image };
  return embed;
}

// New-arrival embed for listing watches.
function buildArrivalEmbed(snap, watch) {
  const lines = [`🆕 **Neu im Shop**${snap.price != null ? ` — ${fmtPrice(snap.price, snap.currency)}` : ''}`];
  lines.push(snap.available === false ? '_(noch nicht kaufbar)_' : '🟢 verfügbar');
  if (snap.sourceNote) lines.push(`\`${snap.sourceNote}\``);
  const embed = {
    title: clip(`🆕 ${snap.name || snap.id}`, 240),
    url: snap.url,
    description: clip(lines.join('\n'), MAX_EMBED_DESCRIPTION),
    color: 0x8b5cf6,
    fields: [
      { name: 'Preis', value: fmtPrice(snap.price, snap.currency), inline: true },
      { name: 'Shop', value: String(watch.site), inline: true },
      { name: 'Status', value: snap.available === false ? 'noch nicht' : 'verfügbar', inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: `Online Monitor • new-arrival` }
  };
  if (snap.image) embed.thumbnail = { url: snap.image };
  return embed;
}

// Listing watch: track seen product ids; first poll seeds the baseline, later
// polls alert on every new product ("neu geladene Boxen").
async function processListing(watch, ctx, force = false) {
  const { config, state, now } = ctx;
  const wState = state[watch.id] || { nextCheckAt: 0, errorStreak: 0, seen: {}, seededAt: null };
  wState.seen = wState.seen || {};
  if (!force && (wState.nextCheckAt || 0) > now) return;

  let items;
  try {
    items = (await withTimeout(listingFor(watch)(watch), watchTimeoutMs(config, watch), watch.id)) || [];
  } catch (err) {
    wState.errorStreak = (wState.errorStreak || 0) + 1;
    wState.nextCheckAt = now + errorBackoffMs(config, wState.errorStreak);
    state[watch.id] = wState;
    console.warn(`[${watch.id}] listing fetch failed (streak ${wState.errorStreak}): ${err.message}`);
    status.record(watch, false, err.message);
    return;
  }
  wState.errorStreak = 0;
  status.record(watch, true, `${items.length} Produkte (Listing)`);

  const firstRun = wState.seededAt == null;
  let newCount = 0;
  for (const snap of items) {
    if (!snap || !snap.id) continue;
    if (wState.seen[snap.id]) continue;
    wState.seen[snap.id] = now;
    if (!firstRun) {
      newCount += 1;
      try {
        await ctx.deliver(watch, buildArrivalEmbed(snap, watch));
        console.log(`[${watch.id}] NEW ARRIVAL — ${snap.name} (${snap.url})`);
      } catch (err) { console.error(`[${watch.id}] discord send failed: ${err.message}`); }
    }
  }
  // prune the seen-set so it can't grow unbounded
  const ids = Object.keys(wState.seen);
  if (ids.length > 3000) {
    ids.sort((a, b) => wState.seen[a] - wState.seen[b]).slice(0, ids.length - 3000).forEach((k) => delete wState.seen[k]);
  }
  wState.seededAt = wState.seededAt || now;
  console.log(`[${watch.id}] listing: ${items.length} products — ${firstRun ? 'seeded baseline (no alerts)' : newCount + ' new'}`);
  wState.lastChecked = now;
  wState.nextCheckAt = now + pollMsFor(config, watch);
  state[watch.id] = wState;
}

// ── per-watch processing ─────────────────────────────────────────────────────
async function processWatch(watch, ctx, force = false) {
  const { config, state, now } = ctx;
  if (isListing(watch)) return processListing(watch, ctx, force);
  const wState = state[watch.id] || { nextCheckAt: 0, errorStreak: 0, item: {} };
  wState.item = wState.item || {};

  if (!force && (wState.nextCheckAt || 0) > now) return; // not due yet

  let snap;
  try {
    snap = await withTimeout(fetcherFor(watch)(watch), watchTimeoutMs(config, watch), watch.id);
  } catch (err) {
    wState.errorStreak = (wState.errorStreak || 0) + 1;
    wState.nextCheckAt = now + errorBackoffMs(config, wState.errorStreak);
    state[watch.id] = wState;
    console.warn(`[${watch.id}] fetch failed (streak ${wState.errorStreak}, retry in ${Math.round((wState.nextCheckAt - now) / 60000)}m): ${err.message}`);
    status.record(watch, false, err.message);
    return `⚠️ \`${watch.id}\` — Fehler: ${err.message}`;
  }
  wState.errorStreak = 0;
  status.record(watch, true, snap.available === true ? 'in stock' : snap.available === false ? 'OOS' : 'unknown');

  const settings = availability.resolveSettings(config, watch);
  const verdict = availability.evaluate(wState.item, snap, settings, now);

  let line;
  if (verdict.alert) {
    try {
      await ctx.deliver(watch, buildEmbed({ snap, verdict, watch }));
      wState.item.lastSentAt = now;
      console.log(`[${watch.id}] ALERT ${verdict.reason} — ${snap.name} @ ${fmtPrice(snap.price)} (${snap.sourceNote})`);
    } catch (err) {
      console.error(`[${watch.id}] discord send failed: ${err.message}`);
    }
    line = `🔔 \`${watch.id}\` — ALERT (${verdict.reason}) @ ${fmtPrice(snap.price, snap.currency)}`;
  } else {
    const st = snap.available === true ? 'verfügbar' : snap.available === false ? 'nicht verfügbar' : 'unbekannt';
    console.log(`[${watch.id}] ${snap.available === true ? 'in stock' : snap.available === false ? 'OOS' : 'unknown'} @ ${fmtPrice(snap.price)} — no alert (${verdict.reason || 'no change'})`);
    line = `${snap.available === true ? '🟢' : '⚪'} \`${watch.id}\` — ${st} @ ${fmtPrice(snap.price, snap.currency)}`;
  }

  wState.lastChecked = now;
  wState.nextCheckAt = now + pollMsFor(config, watch);
  state[watch.id] = wState;
  return line;
}

async function runDueOnce(config, state, deliver, { force }) {
  reloadWatches(config); // pick up watches the bot added/removed since last tick
  const now = Date.now();
  const ctx = { config, state, now, deliver };
  for (const watch of enabledWatches(config)) {
    await processWatch(watch, ctx, force);
  }
  saveState(state);
  status.flush(); // SITE-STATUS.md nach jedem Tick aktualisieren
}

async function shutdownAll() {
  await browser.shutdown().catch(() => null);
  await http.shutdown().catch(() => null);
}

// Build the delivery function. Alerts go to the primary destination (webhook or
// bot default target); a watch with its own `channelId` is posted there via the
// bot client instead (requires a bot token).
function makeDeliver(config, primary, botClient) {
  return async function deliver(watch, embed) {
    if (watch.channelId && botClient) {
      return botClient.sendEmbed({ kind: 'channel', channelId: watch.channelId }, embed);
    }
    return primary.sendEmbed(config.discord.target, embed);
  };
}

async function main() {
  const config = loadConfig();
  const state = loadState();
  const primary = config.discord.webhookUrl
    ? new WebhookClient({ webhookUrl: config.discord.webhookUrl, username: config.discord.username })
    : new DiscordClient({ botToken: config.discord.botToken, username: config.discord.username });
  // A bot client for per-watch channel delivery and the slash-command bot. Reuse
  // `primary` if it's already a bot client, else build one when a token exists.
  const botClient = config.discord.botToken
    ? (primary instanceof DiscordClient ? primary : new DiscordClient({ botToken: config.discord.botToken, username: config.discord.username }))
    : null;
  const deliver = makeDeliver(config, primary, botClient);
  console.log(`  delivery: ${config.discord.webhookUrl ? 'webhook URL' : 'bot → ' + (config.discord.target?.kind || '?')}${botClient ? ' (+ per-watch channels via bot)' : ''}`);

  const watches = enabledWatches(config);
  console.log(`online_monitor started — ${watches.length} watch(es)`);
  const bySite = {};
  for (const w of watches) bySite[w.site] = (bySite[w.site] || 0) + 1;
  console.log(`  sites: ${Object.entries(bySite).map(([s, n]) => `${s}×${n}`).join(', ') || '(none)'}`);
  console.log(`  defaults: poll=${config.defaults?.pollMinutes ?? 10}min, cooldown=${config.defaults?.reAlertCooldownMinutes ?? availability.DEFAULTS.reAlertCooldownMinutes}min, tick=${TICK_MS / 1000}s`);
  if (!watches.length) console.log('  (no watches configured yet — add entries to config.json "watches" or use the bot\'s /add)');
  if (RUN_ONCE) console.log('  mode: --once (force all watches, then exit)');

  // /check hook: force an immediate poll of selected (or all enabled) watches and
  // return human-readable result lines for the bot to post back.
  async function checkNow(ids) {
    reloadWatches(config);
    const now = Date.now();
    const ctx = { config, state, now, deliver };
    let list = enabledWatches(config);
    if (ids && ids.length) list = list.filter((w) => ids.includes(w.id));
    if (!list.length) return ['(keine passenden, aktiven Produkte)'];
    const lines = [];
    for (const w of list) lines.push((await processWatch(w, ctx, true)) || `\`${w.id}\` — geprüft`);
    saveState(state);
    return lines;
  }

  if (RUN_ONCE) {
    await runDueOnce(config, state, deliver, { force: true });
    await shutdownAll();
    return;
  }

  // Start the slash-command bot FIRST so it logs in and is responsive right away,
  // independent of how long the initial (browser-heavy) fetch sweep takes.
  const bot = startBot(config, { checkNow });

  let interval = null;
  if (BOT_ONLY) {
    console.log('  mode: --bot-only (nur Slash-Commands, kein Poll-Loop; /check prüft on demand)');
  } else {
    await runDueOnce(config, state, deliver, { force: false });
    interval = setInterval(() => {
      runDueOnce(config, state, deliver, { force: false }).catch((err) => console.error(`tick error: ${err.message}`));
    }, TICK_MS);
  }

  function shutdown(signal) {
    console.log(`received ${signal}, exiting.`);
    clearInterval(interval);
    Promise.resolve(bot.shutdown()).catch(() => null).finally(() => shutdownAll().finally(() => process.exit(0)));
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => { console.error(err); process.exit(1); });
