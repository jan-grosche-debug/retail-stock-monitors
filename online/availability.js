// Alert engine for the online monitor — pure functions, no I/O.
//
// Two independent signals per watched item:
//   1. RESTOCK  — the item went from not-available (or unseen) to available.
//      This is the primary signal for a "drop / restock" monitor.
//   2. PRICEDROP — optional; current price fell >= minDropPercent below a
//      rolling baseline. Same model as idealo_monitor/reduction.js so the two
//      monitors behave consistently. Off unless `trackPriceDrops` is set.
//
// Everything is config-driven (defaults ← per-watch overrides) so future
// filters slot in without touching the loop or the fetchers.

const DEFAULTS = {
  alertOnFirstSeenAvailable: true, // tell me right away if it's already buyable
  reAlertCooldownMinutes: 180,     // don't re-spam an item that stays in stock
  // price-drop knobs (only used when trackPriceDrops === true)
  trackPriceDrops: false,
  minDropPercent: 20,
  reAlertStepPercent: 5,
  baselineMode: 'recentMax',       // 'recentMax' | 'recentMedian' | 'firstSeen'
  historyWindow: 50,
  minBaselineSamples: 1
};

function resolveSettings(config, watch) {
  return { ...DEFAULTS, ...(config.defaults || {}), ...(watch || {}) };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeBaseline(prices, mode) {
  if (!prices.length) return null;
  switch (mode) {
    case 'firstSeen': return prices[0];
    case 'recentMedian': return median(prices);
    case 'recentMax':
    default: return Math.max(...prices);
  }
}

function pctDrop(baseline, current) {
  if (!baseline || baseline <= 0 || current == null) return 0;
  return ((baseline - current) / baseline) * 100;
}

// Decide what to do with a fresh snapshot.
//
//   itemState : persisted per-item state (mutated & returned)
//   snap      : { available: bool|null, price: Number|null, ... }
//   settings  : resolveSettings(config, watch)
//   now       : Date.now()
//
// Returns { alert, reason, available, price, baseline, dropPercent }.
function evaluate(itemState, snap, settings, now = Date.now()) {
  itemState.history = itemState.history || []; // [{ t, available, price }]
  const priceHistory = itemState.history.map((h) => h.price).filter((p) => typeof p === 'number' && p > 0);

  const available = snap.available;
  const price = snap.price;
  const seenBefore = itemState.history.length > 0;

  // Optional price cap: an alert only "qualifies" when in stock AND at/below the
  // cap. This both filters by price and (because we only fire on the transition
  // into the qualifying state) prevents spam on a permanently-in-stock product.
  const maxPrice = settings.maxPrice != null && settings.maxPrice !== '' ? Number(settings.maxPrice) : null;
  const priceOk = maxPrice == null || (price != null && price <= maxPrice);
  const qualifies = available === true && priceOk;
  const wasQualified = itemState.lastQualified === true;

  let alert = false;
  let reason = null;

  // ── 1. restock / in-stock / price-target signal ────────────────────────────
  if (qualifies) {
    const became = !wasQualified;            // unseen / OOS / over-cap → now qualifying
    const firstSight = !seenBefore;
    const cooldownMs = (settings.reAlertCooldownMinutes ?? DEFAULTS.reAlertCooldownMinutes) * 60 * 1000;
    const cooledDown = !itemState.lastRestockAlertAt || (now - itemState.lastRestockAlertAt) >= cooldownMs;

    if (became && (!firstSight || settings.alertOnFirstSeenAvailable) && cooledDown) {
      alert = true;
      reason = maxPrice != null ? 'price-target' : (firstSight ? 'in-stock' : 'restock');
      itemState.lastRestockAlertAt = now;
    }
  }

  // ── 2. optional price-drop signal ───────────────────────────────────────────
  let baseline = computeBaseline(priceHistory, settings.baselineMode);
  let dropPercent = baseline ? pctDrop(baseline, price) : 0;
  if (!alert && settings.trackPriceDrops && available !== false && price != null) {
    const enoughSamples = priceHistory.length >= (settings.minBaselineSamples || 1);
    if (enoughSamples && baseline && dropPercent >= settings.minDropPercent) {
      const prev = itemState.lastAlertedPrice;
      if (prev == null || price <= prev * (1 - settings.reAlertStepPercent / 100)) {
        alert = true;
        reason = prev == null ? 'price-drop' : 'price-drop-deeper';
        itemState.lastAlertedPrice = price;
      }
    } else if (dropPercent < settings.minDropPercent) {
      itemState.lastAlertedPrice = null; // re-arm
    }
  }

  // ── persist history ─────────────────────────────────────────────────────────
  itemState.history.push({ t: now, available: available === true, price: price ?? null });
  const cap = settings.historyWindow || DEFAULTS.historyWindow;
  if (itemState.history.length > cap) itemState.history.splice(0, itemState.history.length - cap);
  itemState.lastAvailable = available;
  itemState.lastQualified = qualifies;
  itemState.lastPrice = price;

  return { alert, reason, available, price, baseline, dropPercent, maxPrice };
}

module.exports = { DEFAULTS, resolveSettings, computeBaseline, pctDrop, evaluate };
