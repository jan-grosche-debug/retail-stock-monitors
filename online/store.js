// Watch store — the single source of truth is config.json's "watches" array.
//
// The Discord bot mutates the watchlist through here; the monitor loop re-reads
// config.json every tick, so additions/removals take effect without a restart.
// All writes are atomic (write tmp + rename) to avoid the monitor reading a
// half-written file.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function load() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(cfg.watches)) cfg.watches = [];
  return cfg;
}

function save(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function slug(s) {
  return String(s || '').replace(/[^a-z0-9]+/gi, '').slice(0, 32).toLowerCase() || 'x';
}

// Build a unique watch id within the current config.
function uniqueId(cfg, base) {
  const taken = new Set(cfg.watches.map((w) => w.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) { const id = `${base}-${i}`; if (!taken.has(id)) return id; }
}

function listWatches() { return load().watches; }

function findWatch(id) { return load().watches.find((w) => w.id === id) || null; }

// Add an array of partial watch objects (each must carry `site` + an identifier).
// Returns the created watch objects (with ids filled in). Skips exact duplicates
// (same site + same identifier + same maxPrice) and reports them separately.
function addWatches(partials) {
  const cfg = load();
  const created = [];
  const skipped = [];
  for (const p of partials) {
    const ident = p.ean || p.pid || p.asin || p.url || '';
    const dup = cfg.watches.find((w) =>
      w.site === p.site &&
      (w.ean || w.pid || w.asin || w.url || '') === ident &&
      (w.maxPrice ?? null) === (p.maxPrice ?? null));
    if (dup) { skipped.push({ ...p, existingId: dup.id }); continue; }
    const capPart = p.maxPrice != null ? `-max${p.maxPrice}` : '';
    const base = `${p.site}-${slug(ident)}${capPart}`;
    // `source: 'bot'` marks watches created via the Discord bot. With
    // defaults.botWatchesOnly the monitor only polls/alerts on these.
    const watch = { id: uniqueId(cfg, base), enabled: true, ...p, source: 'bot', addedAt: new Date().toISOString() };
    cfg.watches.push(watch);
    created.push(watch);
  }
  if (created.length) save(cfg);
  return { created, skipped };
}

function removeWatch(id) {
  const cfg = load();
  const before = cfg.watches.length;
  cfg.watches = cfg.watches.filter((w) => w.id !== id);
  if (cfg.watches.length === before) return false;
  save(cfg);
  return true;
}

// Merge a patch into a watch (e.g. { pollMinutes:5 }, { channelId:"…" },
// { trackPriceDrops:true, minDropPercent:20 }). Returns the updated watch or null.
function updateWatch(id, patch) {
  const cfg = load();
  const w = cfg.watches.find((x) => x.id === id);
  if (!w) return null;
  Object.assign(w, patch);
  save(cfg);
  return w;
}

function setEnabled(id, enabled) {
  const cfg = load();
  const w = cfg.watches.find((x) => x.id === id);
  if (!w) return false;
  w.enabled = enabled;
  save(cfg);
  return true;
}

module.exports = { CONFIG_PATH, load, save, listWatches, findWatch, addWatches, removeWatch, updateWatch, setEnabled };
