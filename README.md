# Retail Stock Monitors

Stock monitors for German retail, built for the trading-card and collectibles reselling scene. They watch **in-store availability** at physical chains and **online restocks** at Shopify shops, and post Discord alerts only when something actually changes. They ran 24/7 on a Linux VPS for a private Discord community.

## In-store monitors (`instore/`)

Physical-store stock by EAN, for every branch in a region:

| Chain | How it works |
|---|---|
| **Galeria** | Calls the store-finder availability endpoint with a Chrome-like TLS fingerprint (cycletls). A headless-browser fallback is included. |
| **Rossmann** | Resolves the EAN to Rossmann's internal article number in a stealth browser, then queries the store finder per postcode region. |
| **Smyths Toys** | Resolves the EAN to a product ID and reads the per-store stock counts from the store API. It can also discover new Pokémon products automatically. |

- **Smart scheduling:** items in stock are re-checked every 20 minutes, sold-out items every 12 hours. After fetch errors the monitor backs off exponentially.
- **No spam:** an alert is only sent when the *set of stocked stores* changes. This is detected with a hash per EAN and platform.
- **Discord delivery:** rich embeds with the stores and stock counts, per-platform target channels, and optional role pings for newly stocked cities (`autopinger.js`).
- **Price-check bot:** `/idealo`, `/ebay` and `/cardmarket` slash commands for quick price research (`price-checker.js`).

```bash
node instore/index.js          # run continuously
node instore/index.js --once   # check every EAN once, then exit
```

## Online monitor (`online/`)

Restock and price-drop monitoring for Shopify shops, controlled from Discord:

- **Generic Shopify adapter.** It resolves an EAN to a product through `/search/suggest.json`, reads `/products/<handle>.js`, and picks the variant whose barcode matches the EAN.
- **19 preset shops** (TCG and collectibles) plus TCGViert and Feenturm. Any other Shopify shop works by pasting a product URL.
- **Discord slash-command bot:**
  - `/track ean:<EAN>` watches one product across all EAN-capable shops at once.
  - `/add` adds a single product via menus and forms.
  - `/products` lists all watches.
- **Alert logic:** restock alerts, optional maximum price, price-drop percentage, and a cooldown so the same restock is not reported twice.
- **Proxy support:** each site can use its own proxy, and a proxy health check is included (`tools/proxy-check.js`).

**Live-verified on 2026-09-28:** all 21 shops in the catalog answered the adapter's endpoint correctly. Shops that had changed their platform were removed from the preset list.

```bash
node online/index.js            # polling loop + slash-command bot
node online/index.js --once     # one pass over all watches
node online/index.js --bot-only # only the Discord command interface
```

## Setup

1. `npm install` (Node.js ≥ 18)
2. Copy `instore/config.example.json` and `online/config.example.json` to `config.json` in the same folder. Fill in a Discord bot token and channel, or a webhook, and the EANs to watch.
3. Start the monitors with the commands above.

## Tests

```bash
npm test
```

The tests run offline. The Shopify parser is tested against a real API response recorded from a live shop.

## Notes

- Code comments and Discord messages are partly in German, because the target community is in Germany.
- The monitors only read public stock information and never buy anything. Keep polling intervals reasonable.

## License

MIT
