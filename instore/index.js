// Galeria in-store stock monitor.
//
// Scheduling:
//   - Each EAN has its own nextCheckAt timestamp.
//   - In-stock products are re-polled every POLL_INSTOCK_MS (20 min).
//   - Out-of-stock products are re-polled every POLL_OOS_MS (12 h).
//   - On fetch error, exponential backoff capped at 8 * POLL_ERROR_BACKOFF_MS.
//   - The main loop ticks every TICK_MS (60 s) and processes only EANs that
//     are due. No global "all at once" cycle.
//
// Webhook policy:
//   - First sighting of an in-stock product → send (so you know the bot
//     is alive and which products are currently available).
//   - First sighting of an OOS product → just record state, no webhook
//     (avoids 40+ "OOS" pings on first start).
//   - Otherwise: only send when the set of stocked stores actually changes.
//     The embed includes a diff (which stores were added / removed).
//
// State is persisted to state.json so a restart picks up where it left off.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DiscordClient } = require('./discord');
const { AutoPinger } = require('./autopinger');
const { PriceChecker } = require('./price-checker');
const galeria = require('./galeria');
const rossmann = require('./rossmann');
const smyths = require('./smyths');
const smythsDiscover = require('./smyths-discover');

// Platform router: each EAN entry can carry
// `platform: "galeria" | "rossmann" | "smyths"` (default: "galeria").
const PLATFORMS = {
  galeria: { fetcher: galeria.fetchEanSnapshot, shutdown: galeria.shutdownBrowser, label: 'Galeria' },
  rossmann: { fetcher: rossmann.fetchEanSnapshot, shutdown: rossmann.shutdown, label: 'Rossmann' },
  smyths: { fetcher: smyths.fetchEanSnapshot, shutdown: smyths.shutdown, label: 'Smyths' },
  // Apparel/Sneaker-Retailer. Store-Verfügbarkeits-Endpoint noch nicht verifiziert
  // (siehe SITES.md → „SNIPES/FootLocker/JD"): registriert, aber erst nutzbar
  // sobald ein config.json-Eintrag mit platform + snipesUrl/footlockerUrl/jdUrl
  // existiert UND der Endpoint im Browser bestätigt wurde.
};

function platformFor(entry) {
  const key = String(entry.platform || 'galeria').toLowerCase();
  if (!PLATFORMS[key]) throw new Error(`Unknown platform "${key}" for EAN ${entry.ean}`);
  return PLATFORMS[key];
}

// State key = platform + EAN, so the SAME EAN watched on several platforms
// (e.g. galeria + expert) keeps an independent schedule + store-set. (Keying by
// bare EAN made same-EAN entries share one slot, so only the first ran.)
function entryKey(entry) {
  return `${String(entry.platform || 'galeria').toLowerCase()}:${entry.ean}`;
}

// Per-platform Discord-Channel-Override. Wenn config.discord.targetsByPlatform
// einen Eintrag für die Platform hat, wird DESSEN target benutzt — sonst der
// globale config.discord.target. Greift sowohl für Stock-Webhooks als auch
// für die AutoPinger-Folgenachricht (damit beide im selben Channel landen).
function targetForEntry(config, entry) {
  const key = String(entry.platform || 'galeria').toLowerCase();
  const override = config.discord?.targetsByPlatform?.[key];
  return override || config.discord.target;
}

async function shutdownAll() {
  for (const p of Object.values(PLATFORMS)) {
    await p.shutdown().catch(() => null);
  }
}

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'state.json');

const POLL_INSTOCK_MS = 20 * 60 * 1000;
const POLL_OOS_MS = 12 * 60 * 60 * 1000;
const POLL_DAN_UNRESOLVED_MS = 30 * 60 * 1000; // Rossmann-EAN ohne DAN: alle 30 min versuchen
const POLL_ERROR_BACKOFF_MS = 30 * 60 * 1000;
const SMYTHS_DISCOVER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x täglich
const TICK_MS = 60 * 1000;
const MAX_EMBED_DESCRIPTION = 3500;

const argv = new Set(process.argv.slice(2));
const RUN_ONCE = argv.has('--once');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing ${CONFIG_PATH} — copy config.example.json and fill it in.`);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.discord?.botToken) {
    console.error('config.discord.botToken is required.');
    process.exit(2);
  }
  if (!cfg.discord?.target) {
    console.error('config.discord.target is required (use { kind: "userDm", userId } or { kind: "channel", channelId }).');
    process.exit(2);
  }
  if (!Array.isArray(cfg.galeria?.eans) || cfg.galeria.eans.length === 0) {
    console.error('config.galeria.eans must be a non-empty array.');
    process.exit(2);
  }
  return cfg;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (_) { return {}; }
}

function saveState(state) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function hashStores(stores) {
  const names = stores.map((s) => s.name).sort();
  return crypto.createHash('sha1').update(JSON.stringify(names)).digest('hex');
}

function diffStores(previousNames, currentNames) {
  const prevSet = new Set(previousNames);
  const currSet = new Set(currentNames);
  return {
    added: currentNames.filter((n) => !prevSet.has(n)),
    removed: previousNames.filter((n) => !currSet.has(n))
  };
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// Build an eBay.de "verkauft"-Suchlink, damit man im Webhook direkt
// die letzten Sold-Listings (= Marktpreis) checken kann.
function buildEbaySoldUrl(query) {
  if (!query) return null;
  const cleaned = String(query).trim();
  if (!cleaned) return null;
  const encoded = encodeURIComponent(cleaned);
  return `https://www.ebay.de/sch/i.html?_nkw=${encoded}&_sacat=0&_from=R40&rt=nc&LH_Sold=1`;
}

// Aus einem Label wie "Rossmann — Pokemon KP08.5 …" oder "Smyths (auto) — …"
// den reinen Produktnamen extrahieren, der für eBay-Suche taugt.
function ebayQueryFromEntry(entry, snapshot) {
  if (entry?.ebayQuery) return entry.ebayQuery;
  let raw = entry?.label || snapshot?.productName || '';
  raw = raw.replace(/^\s*(Rossmann|Smyths|Galeria)\s*(\(auto\))?\s*[—–-]\s*/i, '');
  raw = raw.replace(/\s*\((Display|Booster|Top-?Trainer)?-?EAN als Fallback\)\s*$/i, '');
  raw = raw.replace(/\s*\(Label gerne nachpflegen\)\s*$/i, '');
  raw = raw.replace(/\s*EAN\s+\d{8,14}\s*$/i, '');
  return raw.trim();
}

// Per-Produkt Einkaufspreis aus config.purchasePrices ableiten.
// Matched gegen entry.label und snapshot.productName; erstes Match gewinnt.
function findPurchasePrice(config, entry, snapshot) {
  const rules = config?.purchasePrices;
  if (!Array.isArray(rules) || !rules.length) return null;
  const haystack = `${entry?.label || ''} ${snapshot?.productName || ''}`;
  for (const r of rules) {
    if (!r?.keyword || !r?.label) continue;
    try {
      if (new RegExp(r.keyword, 'i').test(haystack)) return r.label;
    } catch (_) { /* ignore broken regex */ }
  }
  return null;
}

function buildEmbed({ snapshot, diff, regionFlag, reason, entry, config }) {
  const sections = [];
  if (diff && (diff.added.length || diff.removed.length)) {
    if (diff.added.length) {
      sections.push(`**🟢 Neu im Bestand (${diff.added.length}):**\n${diff.added.join('\n')}`);
    }
    if (diff.removed.length) {
      sections.push(`**🔴 Nicht mehr im Bestand (${diff.removed.length}):**\n${diff.removed.join('\n')}`);
    }
  }
  if (snapshot.stores.length) {
    sections.push(`**Aktuell verfügbar (${snapshot.stores.length}):**\n${snapshot.stores.map((s) => s.name).join('\n')}`);
  } else {
    sections.push('_In keiner Filiale aktuell verfügbar._');
  }

  const description = clip(sections.join('\n\n'), MAX_EMBED_DESCRIPTION);

  // Color coding:
  //   green   = in-stock with new stores added
  //   yellow  = in-stock but only stores removed
  //   gray    = out of stock
  //   blue    = first-run snapshot (initial sighting)
  let color = 0x6b7280;
  if (snapshot.stores.length) {
    if (reason === 'first-run') color = 0x60a5fa;
    else if (diff?.added.length) color = 0x22c55e;
    else if (diff?.removed.length) color = 0xeab308;
    else color = 0x22c55e;
  } else if (diff?.removed.length) {
    color = 0xef4444; // newly went OOS — red
  }

  const embed = {
    title: snapshot.productName,
    url: snapshot.productUrl,
    description,
    color,
    fields: [
      { name: 'ID', value: String(snapshot.ean), inline: true },
      { name: 'Region', value: regionFlag || '🇩🇪', inline: true },
      { name: 'Filialen', value: String(snapshot.stores.length), inline: true }
    ].concat((() => {
      const ep = findPurchasePrice(config, entry, snapshot);
      return ep ? [{ name: 'Einkaufspreis', value: ep, inline: true }] : [];
    })()),
    timestamp: new Date().toISOString(),
    footer: { text: `${snapshot._platformLabel || 'Instore'} Monitor • ${reason}` }
  };
  if (snapshot.productImage) embed.thumbnail = { url: snapshot.productImage };

  const ebayQuery = ebayQueryFromEntry(entry, snapshot);
  const ebayUrl = buildEbaySoldUrl(ebayQuery);
  if (ebayUrl) {
    embed.fields.push({
      name: '📈 Marktpreis',
      value: `[eBay – zuletzt verkauft: „${clip(ebayQuery, 80)}"](${ebayUrl})`,
      inline: false
    });
  }
  return embed;
}

function nextCheckFor({ inStock, errorStreak, danUnresolved }) {
  if (errorStreak > 0) {
    return Date.now() + POLL_ERROR_BACKOFF_MS * Math.min(8, errorStreak);
  }
  if (danUnresolved) return Date.now() + POLL_DAN_UNRESOLVED_MS;
  return Date.now() + (inStock ? POLL_INSTOCK_MS : POLL_OOS_MS);
}

async function processEan(entry, ctx, force = false) {
  const { config, state, discord, autopinger, now } = ctx;
  const skey = entryKey(entry);
  const previous = state[skey] || {
    hash: null,
    lastChecked: 0,
    nextCheckAt: 0,
    inStock: false,
    lastStoreCount: 0,
    lastStoreNames: [],
    errorStreak: 0,
    lastSentAt: 0
  };

  if (!force && (previous.nextCheckAt || 0) > now) {
    return; // not due yet
  }

  const platform = platformFor(entry);
  let snapshot;
  try {
    snapshot = await platform.fetcher({ ...entry, _log: () => {} });
    snapshot._platformLabel = platform.label;
  } catch (err) {
    previous.errorStreak = (previous.errorStreak || 0) + 1;
    previous.nextCheckAt = nextCheckFor({ inStock: previous.inStock, errorStreak: previous.errorStreak });
    state[skey] = previous;
    console.warn(`[${entry.ean}] fetch failed (streak ${previous.errorStreak}, retry in ${Math.round((previous.nextCheckAt - now) / 60000)}m): ${err.message}`);
    return;
  }
  previous.errorStreak = 0;

  const newHash = hashStores(snapshot.stores);
  const newNames = snapshot.stores.map((s) => s.name);
  const previousNames = previous.lastStoreNames || [];
  const inStock = snapshot.stores.length > 0;
  const isFirstRun = previous.hash === null;
  const changed = !isFirstRun && previous.hash !== newHash;

  let reason = null;
  if (isFirstRun && inStock) reason = 'first-run';
  else if (changed) reason = 'changed';

  if (reason) {
    const diff = isFirstRun ? null : diffStores(previousNames, newNames);
    const embed = buildEmbed({ snapshot, diff, regionFlag: config.galeria.regionFlag, reason, entry, config });
    const target = targetForEntry(config, entry);
    try {
      await discord.sendEmbed(target, embed);
      previous.lastSentAt = now;
      const detail = diff ? `+${diff.added.length}/-${diff.removed.length}` : `${snapshot.stores.length} stores`;
      console.log(`[${entry.ean}] SENT (${reason}, ${detail}, total ${snapshot.stores.length}).`);

      // AutoPinger: cities NEW in stock get a role-mention follow-up.
      // first-run → all current stores count as new; otherwise only diff.added.
      // 24h-cooldown per (product, role) lives in previous.autopingerLastPing.
      const newlyStocked = isFirstRun ? newNames : (diff?.added || []);
      if (autopinger && newlyStocked.length) {
        const ebayUrl = buildEbaySoldUrl(ebayQueryFromEntry(entry, snapshot));
        await autopinger.ping({
          target,
          productName: snapshot.productName,
          productUrl: snapshot.productUrl,
          ebayUrl,
          addedStoreNames: newlyStocked,
          reason,
          eanState: previous
        });
      }
    } catch (err) {
      console.error(`[${entry.ean}] discord send failed: ${err.message}`);
    }
  } else {
    let stateLabel;
    if (snapshot.__danUnresolved) stateLabel = 'DAN noch nicht resolvable';
    else if (inStock) stateLabel = `in-stock (${snapshot.stores.length})`;
    else stateLabel = 'OOS';
    const nextMs = snapshot.__danUnresolved
      ? POLL_DAN_UNRESOLVED_MS
      : (inStock ? POLL_INSTOCK_MS : POLL_OOS_MS);
    console.log(`[${entry.ean}] no change — ${stateLabel}, next check in ${Math.round(nextMs / 60000)}m.`);
  }

  previous.hash = newHash;
  previous.lastChecked = now;
  previous.lastStoreNames = newNames;
  previous.lastStoreCount = snapshot.stores.length;
  previous.inStock = inStock;
  previous.nextCheckAt = nextCheckFor({ inStock, errorStreak: 0, danUnresolved: !!snapshot.__danUnresolved });
  state[skey] = previous;
}

// Discovered Smyths products (from smyths-discover.js) get merged into
// the EAN list every tick. Each becomes a virtual entry with synthetic
// EAN `smyths-{productId}` so the scheduler/state tracking works.
function discoveredAsEans() {
  const data = smythsDiscover.loadDiscovered();
  const entries = [];
  for (const [productId, p] of Object.entries(data.products || {})) {
    entries.push({
      ean: `smyths-${productId}`,
      platform: 'smyths',
      smythsProductId: productId,
      label: `Smyths (auto) — ${p.name || productId}`,
      plzPrefixes: ['481', '53', '50']
    });
  }
  return entries;
}

function buildAllEans(config) {
  const configured = config.galeria.eans || [];
  const discovered = discoveredAsEans();
  // Dedupe: if a config entry already lists this productId for smyths,
  // skip the discovered duplicate.
  const knownProductIds = new Set(
    configured
      .filter((e) => e.platform === 'smyths' && e.smythsProductId)
      .map((e) => String(e.smythsProductId))
  );
  const merged = [...configured];
  for (const d of discovered) {
    if (knownProductIds.has(String(d.smythsProductId))) continue;
    merged.push(d);
  }
  return merged;
}

async function runDueOnce(config, state, discord, autopinger, { force }) {
  const now = Date.now();
  const ctx = { config, state, discord, autopinger, now };
  for (const entry of buildAllEans(config)) {
    await processEan(entry, ctx, force);
  }
  saveState(state);
}

async function main() {
  const config = loadConfig();
  const state = loadState();
  const discord = new DiscordClient({
    botToken: config.discord.botToken,
    username: config.discord.username
  });
  const autopinger = new AutoPinger(config);
  if (autopinger.client) {
    console.log(`  autopinger: enabled, ${autopinger.matchers.length} keyword→role mappings`);
  } else if (config.autopinger?.enabled) {
    console.log('  autopinger: enabled but inactive (missing botToken)');
  }
  const priceChecker = new PriceChecker(config);
  if (priceChecker.active) {
    priceChecker.start();
    console.log(`  price-checker: enabled, restricted to channel ${priceChecker.channelId || '(none)'}`);
  } else if (config.priceChecker?.enabled) {
    console.log('  price-checker: enabled but inactive (missing botToken or guildId)');
  }

  const initialEans = buildAllEans(config);
  console.log(`instore_monitors started — ${initialEans.length} EAN(s) (${config.galeria.eans.length} configured + ${initialEans.length - config.galeria.eans.length} smyths-discovered)`);
  console.log(`  schedule: in-stock=${POLL_INSTOCK_MS / 60000}min, OOS=${POLL_OOS_MS / 3600000}h, tick=${TICK_MS / 1000}s, smyths-discover=${SMYTHS_DISCOVER_INTERVAL_MS / 3600000}h`);
  if (RUN_ONCE) console.log('  mode: --once (force all EANs, then exit)');

  await runDueOnce(config, state, discord, autopinger, { force: RUN_ONCE });
  if (RUN_ONCE) {
    await shutdownAll();
    return;
  }

  // Run Smyths discovery on startup, then every 24h.
  async function runSmythsDiscovery() {
    try {
      const result = await smythsDiscover.runDiscovery({ logger: (m) => console.log(m) });
      console.log(`[discover] total=${result.totalKnown}, new=${result.newlyAdded.length}, errors=${result.errors.length}`);
      if (result.newlyAdded.length) {
        await discord.sendEmbed(config.discord.target, {
          title: `🆕 Smyths Pokemon: ${result.newlyAdded.length} neue Produkte entdeckt`,
          description: result.newlyAdded.slice(0, 25)
            .map((p) => `• \`${p.productId}\` ${p.name || ''}`).join('\n')
            .slice(0, 3500),
          color: 0x60a5fa,
          fields: [
            { name: 'Total bekannt', value: String(result.totalKnown), inline: true },
            { name: 'Neu', value: String(result.newlyAdded.length), inline: true }
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Smyths Discovery — Stock-Check startet ab nächstem Tick' }
        }).catch(() => null);
      }
      // 403-Fehler (= Smyths-Cookies abgelaufen) NICHT als Webhook senden —
      // der Nag jeden Tag bringt nichts; steht im Log und kommt zurück
      // sobald Cookies refreshed sind. Andere Fehler weiterhin pingen.
      const nonAuthErrors = result.errors.filter((e) => !/\b403\b/.test(e));
      if (nonAuthErrors.length) {
        await discord.sendEmbed(config.discord.target, {
          title: '⚠️ Smyths Discovery: Fehler',
          description: nonAuthErrors.join('\n').slice(0, 3500),
          color: 0xef4444,
          timestamp: new Date().toISOString()
        }).catch(() => null);
      }
    } catch (err) {
      console.error(`[discover] crash: ${err.message}`);
    }
  }
  // Don't await on startup so the regular tick loop starts immediately.
  runSmythsDiscovery();
  const discoverInterval = setInterval(runSmythsDiscovery, SMYTHS_DISCOVER_INTERVAL_MS);
  if (discoverInterval.unref) discoverInterval.unref();

  const interval = setInterval(() => {
    runDueOnce(config, state, discord, autopinger, { force: false }).catch((err) => {
      console.error(`tick error: ${err.message}`);
    });
  }, TICK_MS);

  function shutdown(signal) {
    console.log(`received ${signal}, exiting.`);
    clearInterval(interval);
    clearInterval(discoverInterval);
    if (priceChecker.active) priceChecker.shutdown();
    shutdownAll().finally(() => process.exit(0));
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
