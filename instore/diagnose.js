const fs = require('fs');
const path = require('path');
const { DiscordClient } = require('./discord');

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const c = new DiscordClient({ botToken: cfg.discord.botToken });

  const channelId = cfg.discord.target.channelId;
  console.log(`Probe channel ${channelId} …`);
  try {
    const ch = await c.request('GET', `/channels/${channelId}`);
    console.log(`  found: name=${ch.name} guild_id=${ch.guild_id} type=${ch.type}`);
    console.log(`  → bot has at least VIEW access to this channel.`);
    console.log('  → 403 on send means missing SEND_MESSAGES permission. Fix in channel/role permissions.');
  } catch (err) {
    console.log(`  ${err.status || '?'}: ${err.message}`);
    console.log('  → bot is not in the server that owns this channel, or has no view access at all.');
  }

  console.log('\nGuilds the bot can see:');
  const guilds = await c.request('GET', '/users/@me/guilds');
  for (const g of guilds) console.log(`  - ${g.name} (${g.id})`);

  for (const g of guilds) {
    try {
      const channels = await c.request('GET', `/guilds/${g.id}/channels`);
      const hit = channels.find((ch) => ch.id === channelId);
      if (hit) {
        console.log(`\n→ Channel ${channelId} liegt in "${g.name}" als #${hit.name} (type ${hit.type}). Permissions/Override prüfen.`);
      }
    } catch (_) { /* ignore */ }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
