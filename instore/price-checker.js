// Price Checker — Discord-Bot mit drei Slash-Commands:
//   /idealo      query:string  → Idealo-Suchlink
//   /ebay        query:string  → eBay "zuletzt verkauft"-Link
//   /cardmarket  query:string  → Cardmarket-Pokemon-Angebote
//
// Architektur:
//   1. Beim Start werden die zwei Commands per REST-API für die konfigurierte
//      Guild registriert (sofort verfügbar, kein 1h Global-Propagation-Delay).
//   2. WebSocket-Gateway-Connection (op2 IDENTIFY, op1 Heartbeat, op0 READY).
//   3. Auf INTERACTION_CREATE → mit type=4 (CHANNEL_MESSAGE_WITH_SOURCE)
//      antworten. Antwort-Latenz < 3s ist Discord-Pflicht; Embed-Response
//      reicht hier locker.
//
// Channel-Restriction: Wenn config.priceChecker.channelId gesetzt ist und
// der Command in einem anderen Kanal ausgelöst wird, antworten wir mit
// einer ephemeral message ("nur in #channel-name verfügbar"). Das hält den
// Bot still in nicht-vorgesehenen Channels ohne Discord-Permissions
// konfigurieren zu müssen.

const path = require('path');
// Try local node_modules (Mac variant has ws as a direct dep), fall back
// to the AIOBot install (Windows variant shares AIOBot deps).
let WebSocket;
WebSocket = require('ws');

const API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Op-Codes (Discord Gateway protocol)
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const COMMANDS = [
  {
    name: 'idealo',
    description: 'Idealo-Preisvergleich für ein Produkt öffnen',
    options: [{
      name: 'query',
      description: 'Produktname / Suchbegriff',
      type: 3, // STRING
      required: true
    }]
  },
  {
    name: 'ebay',
    description: 'Letzte eBay-Verkäufe (Marktpreis) anzeigen',
    options: [{
      name: 'query',
      description: 'Produktname / Suchbegriff',
      type: 3,
      required: true
    }]
  },
  {
    name: 'cardmarket',
    description: 'Cardmarket-Angebote für ein Pokemon-Produkt öffnen',
    options: [{
      name: 'query',
      description: 'Produktname / Suchbegriff',
      type: 3,
      required: true
    }]
  }
];

function buildIdealoUrl(query) {
  return `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(query)}`;
}

function buildEbaySoldUrl(query) {
  return `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(query)}&_sacat=0&_from=R40&rt=nc&LH_Sold=1`;
}

function buildCardmarketUrl(query) {
  return `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(query)}`;
}

// Bot user-id steckt im ersten Token-Segment, base64-encoded.
function applicationIdFromToken(token) {
  const head = token.split('.')[0];
  return Buffer.from(head, 'base64').toString('utf8');
}

class PriceChecker {
  constructor(config) {
    this.cfg = config?.priceChecker;
    if (!this.cfg?.enabled) { this.active = false; return; }
    if (!this.cfg.botToken || !this.cfg.guildId) {
      console.warn('[price-checker] enabled but missing botToken or guildId — skipped.');
      this.active = false;
      return;
    }
    this.token = this.cfg.botToken;
    this.guildId = String(this.cfg.guildId);
    this.channelId = this.cfg.channelId ? String(this.cfg.channelId) : null;
    this.appId = applicationIdFromToken(this.token);
    this.active = true;
    this.ws = null;
    this.heartbeatInterval = null;
    this.lastSeq = null;
    this.shuttingDown = false;
    this.reconnectAttempt = 0;
  }

  async start() {
    if (!this.active) return;
    try {
      await this.registerCommands();
      console.log(`[price-checker] commands registered for guild ${this.guildId}`);
    } catch (err) {
      console.error(`[price-checker] command registration failed: ${err.message}`);
      // Continue anyway — user might re-register manually.
    }
    this.connect();
  }

  async registerCommands() {
    const url = `${API}/applications/${this.appId}/guilds/${this.guildId}/commands`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(COMMANDS)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  connect() {
    if (this.shuttingDown) return;
    this.ws = new WebSocket(GATEWAY_URL);
    this.ws.on('message', (raw) => this.onMessage(raw));
    this.ws.on('close', (code) => this.onClose(code));
    this.ws.on('error', (err) => console.error(`[price-checker] ws error: ${err.message}`));
  }

  onClose(code) {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if (this.shuttingDown) return;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
    const delay = 1000 * Math.pow(2, this.reconnectAttempt - 1); // 1,2,4,8,16,32,64s
    console.warn(`[price-checker] gateway closed (code=${code}), reconnect in ${delay / 1000}s`);
    setTimeout(() => this.connect(), delay);
  }

  send(op, d) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
    }
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { return; }
    if (msg.s != null) this.lastSeq = msg.s;

    if (msg.op === OP_HELLO) {
      const interval = msg.d.heartbeat_interval;
      // Random initial jitter as Discord recommends.
      setTimeout(() => this.send(OP_HEARTBEAT, this.lastSeq), Math.floor(Math.random() * interval));
      this.heartbeatInterval = setInterval(() => this.send(OP_HEARTBEAT, this.lastSeq), interval);
      this.send(OP_IDENTIFY, {
        token: this.token,
        intents: 0, // slash commands need no intents
        properties: { os: process.platform, browser: 'instore-monitor', device: 'instore-monitor' }
      });
      return;
    }

    if (msg.op === OP_RECONNECT) {
      try { this.ws.close(4000, 'reconnect requested'); } catch (_) {}
      return;
    }
    if (msg.op === OP_INVALID_SESSION) {
      try { this.ws.close(4001, 'invalid session'); } catch (_) {}
      return;
    }

    if (msg.op === OP_DISPATCH) {
      if (msg.t === 'READY') {
        this.reconnectAttempt = 0;
        console.log(`[price-checker] online as ${msg.d.user.username}#${msg.d.user.discriminator || '0'} (id ${msg.d.user.id})`);
        return;
      }
      if (msg.t === 'INTERACTION_CREATE') {
        this.handleInteraction(msg.d).catch((err) => {
          console.error(`[price-checker] interaction error: ${err.message}`);
        });
      }
    }
  }

  async handleInteraction(interaction) {
    // Type 2 = APPLICATION_COMMAND
    if (interaction.type !== 2) return;
    const name = interaction.data?.name;
    const queryOpt = (interaction.data?.options || []).find((o) => o.name === 'query');
    const query = String(queryOpt?.value || '').trim();
    if (!query) return this.respond(interaction, { content: 'Bitte gib einen Suchbegriff an.', flags: 64 });

    if (this.channelId && interaction.channel_id !== this.channelId) {
      return this.respond(interaction, {
        content: `Bitte nutze diesen Command in <#${this.channelId}>.`,
        flags: 64 // EPHEMERAL — nur der User sieht's
      });
    }

    if (name === 'idealo') {
      const url = buildIdealoUrl(query);
      return this.respond(interaction, {
        embeds: [{
          title: `🔍 Idealo-Suche: „${query}"`,
          description: `[Auf Idealo öffnen](${url})`,
          color: 0xff6900
        }],
        flags: 64 // EPHEMERAL — nur der aufrufende User sieht die Antwort
      });
    }
    if (name === 'ebay') {
      const url = buildEbaySoldUrl(query);
      return this.respond(interaction, {
        embeds: [{
          title: `📈 eBay – zuletzt verkauft: „${query}"`,
          description: `[Auf eBay öffnen](${url})`,
          color: 0xe53238
        }],
        flags: 64 // EPHEMERAL — nur der aufrufende User sieht die Antwort
      });
    }
    if (name === 'cardmarket') {
      const url = buildCardmarketUrl(query);
      return this.respond(interaction, {
        embeds: [{
          title: `🃏 Cardmarket-Angebote: „${query}"`,
          description: `[Auf Cardmarket öffnen](${url})`,
          color: 0x004f8d
        }],
        flags: 64 // EPHEMERAL — nur der aufrufende User sieht die Antwort
      });
    }
  }

  async respond(interaction, data) {
    const url = `${API}/interactions/${interaction.id}/${interaction.token}/callback`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 4, data })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[price-checker] callback failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.ws) try { this.ws.close(1000); } catch (_) {}
  }
}

module.exports = { PriceChecker };
