// Minimal Discord bot client — just enough to post embeds to a channel or
// open a DM with a user and post there. No discord.js dependency on purpose:
// keeps the install footprint to zero and the surface area small.
//
// Requires Node 18+ (uses global fetch).

const API = 'https://discord.com/api/v10';

class DiscordClient {
  constructor({ botToken, username }) {
    if (!botToken) throw new Error('discord.botToken is required');
    this.botToken = botToken;
    this.username = username || 'Instore Monitor';
    this.dmChannelByUser = new Map();
  }

  async request(method, path, body) {
    const url = `${API}${path}`;
    const headers = {
      Authorization: `Bot ${this.botToken}`,
      'User-Agent': 'InstoreMonitor (local, 0.1)',
      'Content-Type': 'application/json'
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || '1');
        await sleep(Math.min(30, retryAfter) * 1000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let json = null;
      if (text) { try { json = JSON.parse(text); } catch (_) { /* keep raw */ } }
      if (!res.ok) {
        const message = json?.message || text || `HTTP ${res.status}`;
        const err = new Error(`Discord ${method} ${path} → ${res.status}: ${message}`);
        err.status = res.status;
        err.body = json || text;
        throw err;
      }
      return json;
    }
    throw new Error(`Discord ${method} ${path} → exhausted retries (rate-limit / 5xx)`);
  }

  async openDmChannel(userId) {
    if (!userId) throw new Error('userId is required to open a DM');
    if (this.dmChannelByUser.has(userId)) return this.dmChannelByUser.get(userId);
    const channel = await this.request('POST', '/users/@me/channels', { recipient_id: userId });
    this.dmChannelByUser.set(userId, channel.id);
    return channel.id;
  }

  async resolveChannelId(target) {
    if (!target || typeof target !== 'object') throw new Error('target must be an object');
    if (target.kind === 'channel') {
      if (!target.channelId) throw new Error('target.channelId is required for kind="channel"');
      return target.channelId;
    }
    if (target.kind === 'userDm') {
      if (!target.userId) throw new Error('target.userId is required for kind="userDm"');
      return this.openDmChannel(target.userId);
    }
    throw new Error(`Unknown target kind "${target.kind}"`);
  }

  async sendEmbed(target, embed, contentExtra = '') {
    const channelId = await this.resolveChannelId(target);
    return this.request('POST', `/channels/${channelId}/messages`, {
      content: contentExtra || undefined,
      embeds: [embed],
      username: this.username
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { DiscordClient };
