// AutoPinger — second Discord bot identity that mentions city-roles whenever
// one of their cities newly enters a product's in-stock set.
//
// Wiring: lives next to the main monitor in index.js. After the main bot
// has posted its stock-change embed, autopinger receives the freshly
// added store list and posts a separate (role-pinging) message in the
// same channel.
//
// Config (added to config.json):
//   "autopinger": {
//     "enabled": true,
//     "botToken": "<bot token of the AutoPinger app>",
//     "username": "AutoPinger",
//     "cityRoleMap": {
//       "Köln Marsdorf": "1502...",   // longer keys win (more specific store)
//       "Köln":          "1502...",
//       "Düsseldorf":    "1502..."
//     }
//   }
//
// Trigger policy: pings ONLY when a city moves into the stocked set
// (diff.added on subsequent runs OR every store on the first sighting).
// No pings on "removed" or steady state — that would just be spam.

const { DiscordClient } = require('./discord');

class AutoPinger {
  constructor(config) {
    this.config = config?.autopinger;
    if (!this.config?.enabled) { this.client = null; return; }
    if (!this.config.botToken) {
      console.warn('[autopinger] enabled but no botToken — disabled.');
      this.client = null;
      return;
    }
    this.client = new DiscordClient({
      botToken: this.config.botToken,
      username: this.config.username || 'AutoPinger'
    });
    // Compile a matcher per cityRoleMap entry. Same roleId can appear under
    // multiple keys (e.g. "Köln" + "50" both → Köln-Rolle). Numeric-only keys
    // are treated as PLZ-prefixes and matched at a digit-token boundary so
    // "50" only fires on real postcodes (e.g. "(50858)") not on house numbers
    // somewhere inside a street name.
    const map = this.config.cityRoleMap || {};
    this.matchers = Object.entries(map)
      .filter(([, v]) => v)
      .map(([key, roleId]) => ({
        key,
        roleId: String(roleId),
        test: AutoPinger.compileMatcher(key)
      }));
  }

  static compileMatcher(key) {
    if (/^\d+$/.test(key)) {
      const re = new RegExp(`(^|[^0-9])${key}\\d*(?![0-9])`);
      return (haystack) => re.test(haystack);
    }
    const lc = key.toLowerCase();
    return (haystack) => haystack.toLowerCase().includes(lc);
  }

  // Collect all role mentions for a given store name. A store can hit
  // multiple keywords for the same role (e.g. "Köln" and "50") — we dedupe
  // by roleId so the role gets pinged once per store.
  matchStore(storeName) {
    if (!storeName) return [];
    const seen = new Set();
    const hits = [];
    for (const m of this.matchers) {
      if (seen.has(m.roleId)) continue;
      if (m.test(storeName)) { seen.add(m.roleId); hits.push(m); }
    }
    return hits;
  }

  // Group newly stocked stores by the role(s) they trigger.
  rolesToPing(addedStoreNames) {
    const byRole = new Map();
    for (const name of addedStoreNames) {
      for (const m of this.matchStore(name)) {
        if (!byRole.has(m.roleId)) byRole.set(m.roleId, []);
        byRole.get(m.roleId).push(name);
      }
    }
    return byRole;
  }

  async ping({ target, productName, productUrl, ebayUrl, addedStoreNames, reason, eanState }) {
    if (!this.client || !addedStoreNames?.length) return;
    const byRole = this.rolesToPing(addedStoreNames);
    if (byRole.size === 0) return;

    // 24h cooldown per (product, role): a role that was just pinged for
    // this EAN stays muted for 24h, even if its city flickers in/out of
    // stock. Other roles for the same product can still fire — we only
    // suppress the role that already got the news.
    const cooldownMs = (this.config.perProductCooldownMs ?? 24 * 60 * 60 * 1000);
    const now = Date.now();
    if (eanState && cooldownMs > 0) {
      const history = eanState.autopingerLastPing || {};
      for (const roleId of Array.from(byRole.keys())) {
        if (now - (history[roleId] || 0) < cooldownMs) byRole.delete(roleId);
      }
      if (byRole.size === 0) return;
    }

    const roleIds = Array.from(byRole.keys());
    const mentions = roleIds.map((id) => `<@&${id}>`).join(' ');
    const cityLines = Array.from(byRole.entries())
      .map(([, stores]) => `• ${stores.join(' · ')}`)
      .join('\n');

    const headline = reason === 'first-run' ? 'jetzt verfügbar' : 'NEU im Stock';
    const lines = [
      `${mentions} · **${headline}**`,
      productUrl ? `[${productName}](${productUrl})` : `**${productName}**`,
      cityLines
    ];
    if (ebayUrl) lines.push(`📈 [eBay – zuletzt verkauft](${ebayUrl})`);

    try {
      const channelId = await this.client.resolveChannelId(target);
      await this.client.request('POST', `/channels/${channelId}/messages`, {
        content: lines.join('\n'),
        allowed_mentions: { roles: roleIds },
        username: this.config.username || 'AutoPinger'
      });
      if (eanState) {
        const history = eanState.autopingerLastPing || {};
        for (const roleId of roleIds) history[roleId] = now;
        eanState.autopingerLastPing = history;
      }
    } catch (err) {
      console.error(`[autopinger] send failed: ${err.message}`);
    }
  }
}

module.exports = { AutoPinger };
