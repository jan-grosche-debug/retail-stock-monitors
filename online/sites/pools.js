// Seiten-Pools — die EINE Wahrheit darüber, welcher Shop in welchem Pool liegt.
//
// Ein Pool ist eine Auswahl-Gruppe für die Discord-Commands (/add, /track).
// Anders als das alte `category`-Feld (genau EINS pro Shop) darf ein Shop in
// MEHREREN Pools liegen — weil viele Händler mehrere Nischen bedienen:
//   Alternate  → technik + tcg   (verkauft GPUs UND Pokémon-Displays)
//   MediaMarkt → technik + tcg
//   StockX     → sneaker-fashion + random
//
// Fünf Pools:
//   tcg              Sammelkarten (Pokémon/Lorcana/One Piece/…) + Generalisten, die TCG führen
//   sneaker-fashion  Sneaker-Boutiquen, Sneaker-Händler, Fashion/Streetwear
//   technik          Elektronik/PC/Hardware
//   preisvergleiche  Preisvergleichs- & Deal-Portale (idealo, Geizhals, billiger, …)
//   random           alles andere (Collectibles, Bücher, Marktplätze, beliebige URL)
//
// Zuordnung passiert in zwei Stufen:
//   1) CATEGORY_POOLS  → Default aus der alten `category` (deckt ~85 % ab)
//   2) SITE_POOLS      → expliziter Override je Shop-Key (gewinnt IMMER)
// Neuen Shop hinzufügen = Zeile in presets.js. Der Pool ergibt sich automatisch
// aus seiner category; nur wenn er in mehrere Pools gehört → Zeile in SITE_POOLS.

const POOL_ORDER = ['tcg', 'sneaker-fashion', 'technik', 'preisvergleiche', 'random'];

const POOL_META = {
  tcg: { label: 'TCG / Sammelkarten', emoji: '🎴', desc: 'Pokémon, Lorcana, One Piece, Magic …' },
  'sneaker-fashion': { label: 'Sneaker & Fashion', emoji: '👟', desc: 'Boutiquen, Sneaker-Händler, Streetwear' },
  technik: { label: 'Technik & Elektronik', emoji: '💻', desc: 'GPUs, Konsolen, PC-Hardware, Gadgets' },
  preisvergleiche: { label: 'Preisvergleiche', emoji: '🏷️', desc: 'idealo, Geizhals, billiger.de, Deal-Portale' },
  random: { label: 'Random / Sonstiges', emoji: '🎲', desc: 'Collectibles, Bücher, Marktplätze, beliebige URL' }
};

// Stufe 1 — Default-Pool aus der alten `category`.
const CATEGORY_POOLS = {
  TCG: ['tcg'],
  Sneaker: ['sneaker-fashion'],
  SneakerRetailer: ['sneaker-fashion'],
  Fashion: ['sneaker-fashion'],
  Tech: ['technik'],
  Collectibles: ['random'],
  Marktplatz: ['random'],
  Buch: ['random'],
  Sonstige: ['random']
};

// Stufe 2 — expliziter Override je Shop. Gewinnt über CATEGORY_POOLS.
const SITE_POOLS = {
  // ── Preisvergleiche & Deal-Portale ────────────────────────────────────────
  // Bewusst NUR in diesem Pool: sie führen alles, würden also jeden anderen
  // Pool zumüllen. Wer idealo/Geizhals will, wählt den Preisvergleichs-Pool.
  idealo: ['preisvergleiche'],
  geizhals: ['preisvergleiche'],
  billiger: ['preisvergleiche'],
  guenstiger: ['preisvergleiche'],
  preisde: ['preisvergleiche'],
  check24: ['preisvergleiche'],
  mydealz: ['preisvergleiche'],

  // ── Generalisten: mehrere Pools ───────────────────────────────────────────
  alternate: ['technik', 'tcg'],       // GPUs + Pokémon-Displays
  mediamarkt: ['technik', 'tcg'],      // führt Sammelkarten im Sortiment
  saturn: ['technik', 'tcg'],
  amazon: ['technik', 'tcg', 'sneaker-fashion', 'random'], // führt schlicht alles
  mueller: ['tcg', 'random'],          // Drogerie, aber starker TCG-Kanal
  smythstoys: ['tcg', 'random'],       // Spielzeug + Pokémon
  mytoys: ['tcg', 'random'],
  gamestop: ['tcg', 'random'],

  // ── Marktplätze mit klarem Nischen-Bezug ──────────────────────────────────
  stockx: ['sneaker-fashion', 'random'],
  goat: ['sneaker-fashion', 'random'],
  cardmarket: ['tcg', 'random'],

  // ── Explizit, damit sie nicht an der category hängen ───────────────────────
  nvidia: ['technik'],
  browser: ['random'],                 // generischer URL-Renderer
  pagro: ['random']
};

// Alle Pools eines Shops (Catalog-/Preset-Zeile).
function poolsFor(site) {
  if (!site) return ['random'];
  if (Array.isArray(site.pools) && site.pools.length) return site.pools;
  const override = SITE_POOLS[site.key];
  if (override && override.length) return override;
  const byCat = CATEGORY_POOLS[site.category];
  if (byCat && byCat.length) return byCat;
  return ['random'];
}

function isPool(key) { return POOL_ORDER.includes(String(key || '')); }

module.exports = { POOL_ORDER, POOL_META, CATEGORY_POOLS, SITE_POOLS, poolsFor, isPool };
