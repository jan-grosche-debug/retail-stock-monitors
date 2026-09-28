// Minimal Discord bot client — posts embeds to a channel or a user DM. No
// discord.js dependency on purpose. Verbatim sibling of
// instore_monitors/discord.js and idealo_monitor/discord.js so this folder
// stays self-contained. Requires Node 18+.

const API = 'https://discord.com/api/v10';

class DiscordClient {
  constructor({ botToken, username }) {
    if (!botToken) throw new Error('discord.botToken is required');
    this.botToken = botToken;
    this.username = username || 'Online Monitor';
    this.dmChannelByUser = new Map();
  }

  async request(method, path, body) {
    const url = `${API}${path}`;
    const headers = {
      Authorization: `Bot ${this.botToken}`,
      'User-Agent': 'OnlineMonitor (local, 0.1)',
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

// Alternative delivery: a Discord *webhook URL* (no bot/token needed). Exposes
// the same `sendEmbed(target, embed)` interface as DiscordClient so index.js can
// use either transparently. `target` is ignored — a webhook is bound to one
// channel already.
class WebhookClient {
  constructor({ webhookUrl, username }) {
    if (!webhookUrl || !/discord(app)?\.com\/api\/webhooks\//i.test(webhookUrl)) {
      throw new Error('discord.webhookUrl must be a Discord webhook URL');
    }
    this.webhookUrl = webhookUrl;
    this.username = username || 'Online Monitor';
  }

  async sendEmbed(_target, embed, contentExtra = '') {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, content: contentExtra || undefined, embeds: [embed] })
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || '1');
        await sleep(Math.min(30, retryAfter) * 1000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) { await sleep(1000 * (attempt + 1)); continue; }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Discord webhook → ${res.status}: ${text.slice(0, 200)}`);
      }
      return true;
    }
    throw new Error('Discord webhook → exhausted retries');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { DiscordClient, WebhookClient };
