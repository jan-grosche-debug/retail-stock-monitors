// Auto-link helper: uses the bot token in config.json to discover the bot's
// guilds, infer the owner (presumed to be the human user), open a DM, and
// send a test embed. Writes the discovered userId back to config.json.
//
// Run once after installing the bot to a server you own:
//   node link.js

const fs = require('fs');
const path = require('path');
const { DiscordClient } = require('./discord');

const CONFIG_PATH = path.join(__dirname, 'config.json');

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const token = cfg.discord?.botToken;
  if (!token || token.startsWith('PASTE-')) {
    console.error('config.discord.botToken is missing.');
    process.exit(2);
  }

  const client = new DiscordClient({ botToken: token, username: cfg.discord.username });

  // 1. Token sanity check.
  const me = await client.request('GET', '/users/@me');
  console.log(`Bot is ${me.username}#${me.discriminator || '0'}  (id ${me.id})`);

  // 2. Where is the bot installed?
  const guilds = await client.request('GET', '/users/@me/guilds');
  if (!guilds.length) {
    console.error('\nDer Bot ist in keinem Server.');
    console.error('Lade ihn zuerst auf einen Server ein, dann diesen Befehl erneut starten:');
    console.error(`  https://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot&permissions=2048`);
    process.exit(3);
  }
  console.log(`Bot ist in ${guilds.length} Server(n):`);
  for (const g of guilds) console.log(`  - ${g.name} (${g.id})`);

  // 3. Find the owner of those guilds. Same owner across all → that's the user.
  const ownerCounts = new Map();
  const ownerNames = new Map();
  for (const g of guilds) {
    const detail = await client.request('GET', `/guilds/${g.id}`);
    const ownerId = detail.owner_id;
    ownerCounts.set(ownerId, (ownerCounts.get(ownerId) || 0) + 1);
    if (!ownerNames.has(ownerId)) {
      try {
        const u = await client.request('GET', `/users/${ownerId}`);
        ownerNames.set(ownerId, `${u.username}${u.discriminator && u.discriminator !== '0' ? `#${u.discriminator}` : ''}`);
      } catch (_) { ownerNames.set(ownerId, ownerId); }
    }
  }

  const sorted = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1]);
  const [topOwnerId] = sorted[0];
  console.log(`\nWahrscheinlicher Empfänger: ${ownerNames.get(topOwnerId)} (${topOwnerId}) — Eigentümer von ${sorted[0][1]} Server(n).`);

  // 4. Persist the userId, then send a test DM.
  cfg.discord.target = { kind: 'userDm', userId: topOwnerId };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log('config.json aktualisiert (target.userId).');

  const embed = {
    title: 'Galeria Instore Monitor — verbunden',
    description: 'Wenn du das hier siehst, ist die Discord-Anbindung korrekt.\nAb jetzt kommen Stock-Updates für die in `config.json` konfigurierten EANs hierher.',
    color: 0x22c55e,
    fields: [
      { name: 'Bot', value: `${me.username} (${me.id})`, inline: true },
      { name: 'Region', value: cfg.galeria?.regionFlag || '🇩🇪', inline: true },
      { name: 'EANs überwacht', value: String(cfg.galeria?.eans?.length || 0), inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'instore_monitors • link.js' }
  };

  await client.sendEmbed(cfg.discord.target, embed);
  console.log('Test-DM gesendet ✓');
}

main().catch((err) => {
  console.error('Fehler:', err.message);
  if (err.body) console.error(err.body);
  process.exit(1);
});
