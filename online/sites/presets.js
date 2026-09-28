// Data-driven shop presets — add a shop by adding a row here, no new file.
//
// SHOPIFY_PRESETS  → generic Shopify adapter (cycletls, no browser). EAN works via
//                    the search fallback; URL/handle always works. `kind:'ean'`
//                    rows are auto-included in /track.
// BROWSER_PRESETS  → rendered-PDP reader (JSON-LD). For non-Shopify / hard bot-wall
//                    shops; monitored by product URL. `headful:true` → real window.
// BOOK_PRESETS     → EAN/ISBN search via the bookRetailer scraper.
//
// Each row: { key, label, domain, category, kind, emoji, walled?, headful? }
//   category: 'TCG' | 'Collectibles' | 'Sneaker' | 'SneakerRetailer' | 'Fashion' | 'Tech' | 'Marktplatz' | 'Sonstige'
//   kind:     'ean' | 'url'
//   walled:   true → realistically needs a residential/ISP proxy from a DC IP
//   headful:  (browser presets) launch a real window (Akamai/DataDome/PerimeterX/Queue-it)
//
// Only shops verified live on 2026-09-28 are listed. BROWSER/BOOK presets are
// supported by the engine design but intentionally empty in this public version.

const SHOPIFY_PRESETS = [
  // ── TCG / Sammelkarten (Shopify → EAN-fähig) ──
  { key: 'fantasiacards', label: 'Fantasia Cards', domain: 'fantasiacards.de', category: 'TCG', kind: 'ean', emoji: '🎴' },
  { key: 'tradingtoys', label: 'TradingToys', domain: 'tradingtoys.de', category: 'TCG', kind: 'ean', emoji: '🧸' },
  { key: 'tcgcorner', label: 'TCG-Corner', domain: 'tcg-corner.com', category: 'TCG', kind: 'ean', emoji: '🀄' },
  { key: 'kofuku', label: 'Kofuku', domain: 'kofuku.de', category: 'TCG', kind: 'ean', emoji: '🎴' },
  { key: 'cardcosmos', label: 'CardCosmos', domain: 'cardcosmos.de', category: 'TCG', kind: 'ean', emoji: '🌌' },
  { key: 'mrcollect', label: 'Mr. Collect', domain: 'mr-collect.de', category: 'TCG', kind: 'ean', emoji: '🃏' },
  { key: 'cardcollector', label: 'Card-Collector', domain: 'card-collector.net', category: 'TCG', kind: 'ean', emoji: '🗂️' },
  { key: 'pokeflip', label: 'Pokeflip', domain: 'pokeflip.com', category: 'TCG', kind: 'ean', emoji: '🔁' },
  { key: 'crispycards', label: 'CrispyCards', domain: 'crispycards.de', category: 'TCG', kind: 'ean', emoji: '🍥' },
  { key: 'cardstoreat', label: 'cardstore.at', domain: 'cardstore.at', category: 'TCG', kind: 'ean', emoji: '🇦🇹' },
  { key: 'coso5', label: "Collector's Society 5", domain: 'coso5.at', category: 'TCG', kind: 'ean', emoji: '🏆' },

  // ── Collectibles (Shopify → EAN-fähig) ──
  { key: 'stuffbringer', label: 'Stuffbringer', domain: 'stuffbringer.com', category: 'Collectibles', kind: 'ean', emoji: '📦' },
  { key: 'kameco', label: 'Kameco', domain: 'kameco.de', category: 'Collectibles', kind: 'ean', emoji: '🐢' },
  { key: 'nerdmania', label: 'NerdMania', domain: 'nerdmaniashop.de', category: 'Collectibles', kind: 'ean', emoji: '🤓' },
  { key: 'fuyuko', label: 'Fuyuko', domain: 'fuyuko.de', category: 'Collectibles', kind: 'ean', emoji: '❄️' },
  { key: 'lootstore', label: 'Lootstore', domain: 'lootstore.de', category: 'Collectibles', kind: 'ean', emoji: '🎁' },
  { key: 'pophero', label: 'POP HERO', domain: 'pop-hero.com', category: 'Collectibles', kind: 'ean', emoji: '🦸' },
  { key: 'dilaras', label: 'Dilaras', domain: 'dilaras.at', category: 'Collectibles', kind: 'ean', emoji: '🧩' },
  { key: 'stuffhunter', label: 'Stuffhunter', domain: 'stuffhunter.de', category: 'Collectibles', kind: 'ean', emoji: '🏹' },

  // ── Tech (Shopify → EAN-fähig) ──

  // ── Sneaker-Boutiquen (Shopify-Storefronts, per Produkt-URL) ──
];

const BROWSER_PRESETS = [];
const BOOK_PRESETS = [];

module.exports = { SHOPIFY_PRESETS, BROWSER_PRESETS, BOOK_PRESETS };
