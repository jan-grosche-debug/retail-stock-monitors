// Discord REST helpers for the bot — application lookup, slash-command
// registration, and interaction responses. Uses the built-in global fetch
// (Node 18+). Interaction *callbacks* are authenticated by the interaction
// token in the URL and need no Authorization header; everything else uses the
// bot token.

const API = 'https://discord.com/api/v10';

// Interaction callback types we use.
const CALLBACK = {
  CHANNEL_MESSAGE: 4,        // reply with a message
  DEFERRED_MESSAGE: 5,       // "thinking…" — edit later via editOriginal
  DEFERRED_UPDATE: 6,        // ack a component without changing the message
  UPDATE_MESSAGE: 7,         // edit the message the component is on
  MODAL: 9                   // open a modal
};

class Rest {
  constructor(botToken) {
    if (!botToken) throw new Error('bot token required');
    this.token = botToken;
    this._appId = null;
  }

  async _req(method, path, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'OnlineMonitorBot (local, 0.1)' };
    if (auth) headers.Authorization = `Bot ${this.token}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || '1');
        await sleep(Math.min(30, ra) * 1000); continue;
      }
      if (res.status >= 500 && res.status < 600) { await sleep(1000 * (attempt + 1)); continue; }
      const text = await res.text();
      let json = null; if (text) { try { json = JSON.parse(text); } catch (_) { /* keep raw */ } }
      if (!res.ok) {
        const msg = json?.message || text || `HTTP ${res.status}`;
        const err = new Error(`Discord ${method} ${path} → ${res.status}: ${msg}`);
        err.status = res.status; err.body = json || text; throw err;
      }
      return json;
    }
    throw new Error(`Discord ${method} ${path} → exhausted retries`);
  }

  async appId() {
    if (this._appId) return this._appId;
    const app = await this._req('GET', '/applications/@me');
    this._appId = app.id;
    return this._appId;
  }

  // Register (overwrite) the command set. Guild scope = instant; global = ~1h.
  async registerCommands(commands, guildId) {
    const appId = await this.appId();
    const path = guildId
      ? `/applications/${appId}/guilds/${guildId}/commands`
      : `/applications/${appId}/commands`;
    return this._req('PUT', path, commands);
  }

  // First response to an interaction (within 3s).
  respond(interaction, type, data) {
    return this._req('POST', `/interactions/${interaction.id}/${interaction.token}/callback`,
      { type, data }, { auth: false });
  }

  // Edit the original interaction response (after a deferral or to update later).
  async editOriginal(interaction, data) {
    const appId = await this.appId();
    return this._req('PATCH', `/webhooks/${appId}/${interaction.token}/messages/@original`, data, { auth: false });
  }

  // Send an extra (ephemeral-capable) follow-up message.
  async followup(interaction, data) {
    const appId = await this.appId();
    return this._req('POST', `/webhooks/${appId}/${interaction.token}`, data, { auth: false });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { Rest, CALLBACK };
