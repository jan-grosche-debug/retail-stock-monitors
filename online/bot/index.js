// Discord slash-command bot for the online monitor.
//
// Connects to the gateway, registers the command set, and routes interactions
// to the watch store. Adding/removing/editing a watch mutates config.json; the
// monitor loop re-reads it each tick, so changes take effect live.
//
// startBot(config, hooks) — hooks: { checkNow(ids) → Promise<string[]> } lets
// /check force an immediate poll and report the result. Returns a handle with
// shutdown().

const { Gateway } = require('./gateway');
const { Rest, CALLBACK } = require('./rest');
const flow = require('./flow');
const track = require('./track');
const store = require('../store');
const { BY_KEY, sitesInPool } = require('./catalog');

const { ITYPE, FLAG_EPHEMERAL } = flow;

// Shop-Keys, die auf der aktuell gezeigten Seite des Pools stehen. Gebraucht,
// damit ein Select-Submit nur die Auswahl DIESER Seite ersetzt und die auf
// anderen Seiten getroffene Auswahl nicht wegwirft.
function catalogPageKeys(pool, page) {
  const all = sitesInPool(pool);
  return all.slice(page * flow.PAGE_SIZE, (page + 1) * flow.PAGE_SIZE).map((s) => s.key);
}

// /track, /untrack, /products are merged in from the EAN-first layer (track.js).
const ALL_COMMANDS = [...flow.COMMANDS, ...track.EXTRA_COMMANDS];

function fmtCap(w) { return w.maxPrice != null ? ` · ≤${w.maxPrice}€` : ''; }
function clip(s, n) { s = String(s == null ? '' : s); return s.length <= n ? s : `${s.slice(0, n - 1)}…`; }

// pull { name: value } from a slash-command payload
function cmdOpts(it) {
  const o = {};
  for (const x of it.data?.options || []) o[x.name] = x.value;
  return o;
}

// pull { custom_id: value } from a modal submit payload
function modalValues(data) {
  const out = {};
  for (const row of data.components || []) for (const c of row.components || []) out[c.custom_id] = c.value;
  return out;
}

function startBot(config, hooks = {}) {
  const token = config.discord?.botToken;
  if (!token) {
    console.log('  bot: kein discord.botToken gesetzt → Slash-Commands deaktiviert (Alerts laufen weiter über den Webhook).');
    console.log('       So aktivierst du den Bot: discord.botToken in config.json setzen (Developer Portal → Bot → Token),');
    console.log('       Bot mit Scope "bot applications.commands" einladen, optional discord.guildId für sofortige Commands.');
    return { shutdown: async () => {} };
  }

  const rest = new Rest(token);
  const gw = new Gateway(token);

  // Per-user /add sessions, threading state across the step-by-step flow
  // (pool → sites (paginated) → mode → identifiers → prices). Keyed by user id.
  //
  // Warum Session statt custom_id: eine Discord-custom_id darf nur 100 Zeichen
  // lang sein. Die alte Version schrieb die gewählten Shop-Keys hinein — ab ~10
  // Shops riss der Flow ab. Jetzt hält die Session { pool, page, selected[] }.
  const sessions = new Map();
  const SESSION_TTL = 10 * 60 * 1000;
  function uidOf(it) { return it.member?.user?.id || it.user?.id || 'unknown'; }
  function getSession(it) {
    const s = sessions.get(uidOf(it));
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(uidOf(it)); return null; }
    return s;
  }
  function newSession(it) {
    const s = { pool: null, page: 0, selected: [], mode: 'single', idents: {}, createdAt: Date.now() };
    sessions.set(uidOf(it), s);
    return s;
  }
  const EXPIRED = { content: '⏱️ Sitzung abgelaufen — bitte `/add` neu starten.', components: [], embeds: [] };

  gw.on('ready', async (user) => {
    console.log(`  bot: eingeloggt als ${user.username}#${user.discriminator ?? ''} (${user.id})`);
    try {
      await rest.registerCommands(ALL_COMMANDS, config.discord.guildId || null);
      console.log(`  bot: ${ALL_COMMANDS.length} Slash-Commands registriert (${config.discord.guildId ? 'Guild ' + config.discord.guildId + ' — sofort' : 'global — bis zu 1h'}).`);
    } catch (err) { console.error(`  bot: Command-Registrierung fehlgeschlagen: ${err.message}`); }
  });
  gw.on('fatal', (err) => console.error(`  bot: ${err.message} — Token/Intents prüfen.`));
  gw.on('interaction', (it) => handle(it).catch((err) => console.error(`  bot: interaction error: ${err.message}`)));

  async function handle(it) {
    if (it.type === ITYPE.APPLICATION_COMMAND) return onCommand(it);
    if (it.type === ITYPE.MESSAGE_COMPONENT) return onComponent(it);
    if (it.type === ITYPE.MODAL_SUBMIT) return onModal(it);
  }

  // ── slash commands ───────────────────────────────────────────────────────────
  async function onCommand(it) {
    const name = it.data?.name;
    // EAN-first layer (the easy path)
    if (name === 'track') return onTrack(it);
    if (name === 'untrack') return onUntrack(it);
    if (name === 'products') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, productsMessage());
    // classic per-site flow (jetzt Pool-basiert)
    if (name === 'add') { newSession(it); return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.poolSelectMessage()); }
    if (name === 'pools') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.poolsOverviewMessage());
    if (name === 'list') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, listMessage());
    if (name === 'remove') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('remove:pick', '🗑️ Welches Produkt löschen?', store.listWatches()));
    if (name === 'pause') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('toggle:off', '⏸️ Welches Produkt pausieren?', store.listWatches().filter((w) => w.enabled !== false)));
    if (name === 'resume') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('toggle:on', '▶️ Welches Produkt wieder aktivieren?', store.listWatches().filter((w) => w.enabled === false)));
    if (name === 'check') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('check:pick', '🔄 Was sofort prüfen?', store.listWatches().filter((w) => w.enabled !== false), { includeAll: true }));
    if (name === 'interval') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('interval:pick', '⏱️ Bei welchem Produkt das Intervall ändern?', store.listWatches()));
    if (name === 'pricedrop') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('pricedrop:pick', '📉 Bei welchem Produkt den Preis-Drop-Alarm einstellen?', store.listWatches()));
    if (name === 'channel') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.watchSelectMessage('channel:pick', '📣 Für welches Produkt den Ziel-Channel setzen?', store.listWatches()));
    if (name === 'export') return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, exportMessage());
    if (name === 'import') return rest.respond(it, CALLBACK.MODAL, flow.buildImportModal());
    return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: `Unbekannter Befehl: ${name}` });
  }

  // ── /track: one EAN → every EAN-capable shop ───────────────────────────────────
  async function onTrack(it) {
    const o = cmdOpts(it);
    const ean = track.validateEan(o.ean);
    if (!ean) return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: `❌ „${clip(String(o.ean), 40)}" ist keine gültige EAN/GTIN (8–14 Ziffern).` });
    const cap = (typeof o.maxpreis === 'number' && o.maxpreis > 0) ? o.maxpreis : null;
    const group = o.gruppe || 'alle';
    const { partials, sites } = track.buildEanPartials(ean, cap, o.name || '', group);
    if (!partials.length) return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: '❌ Keine EAN-Shops in dieser Gruppe.' });
    const { created, skipped } = store.addWatches(partials);
    return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, embeds: [trackSummaryEmbed(ean, cap, group, created, skipped, sites)] });
  }

  async function onUntrack(it) {
    const o = cmdOpts(it);
    const ean = track.validateEan(o.ean) || String(o.ean || '').replace(/\D/g, '');
    const matches = store.listWatches().filter((w) => (w.ean || '') === ean);
    let n = 0;
    for (const w of matches) { if (store.removeWatch(w.id)) n += 1; }
    return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: n ? `🗑️ EAN \`${ean}\` von **${n}** Shop(s) entfernt.` : `Keine Einträge mit EAN \`${ean}\` gefunden.` });
  }

  function trackSummaryEmbed(ean, cap, group, created, skipped, sites) {
    const lines = [];
    lines.push(`**EAN \`${ean}\`** wird auf **${created.length}** Shop(s) überwacht${cap != null ? ` · ≤ ${cap}€` : ''}${group && group !== 'alle' ? ` · Gruppe: ${group}` : ''}.`);
    if (created.length) { lines.push(''); lines.push(created.map((w) => `\`${w.site}\``).join(' · ')); }
    if (skipped.length) lines.push(`\n♻️ ${skipped.length} bereits vorhanden (übersprungen).`);
    const heavy = sites.filter((s) => track.HEAVY.has(s.key)).map((s) => s.label);
    if (heavy.length) { lines.push(''); lines.push(`🛡️ Proxy/aufwendig (langsameres Intervall): ${clip(heavy.join(', '), 300)}`); }
    lines.push('\n_Tipp: Status pro Shop in `online_monitor/SITE-STATUS.md`._');
    return { title: '✅ Tracking aktiv', description: clip(lines.join('\n'), 3900), color: created.length ? 0x22c55e : 0xeab308 };
  }

  function productsMessage() {
    const watches = store.listWatches();
    if (!watches.length) return { flags: FLAG_EPHEMERAL, content: '📭 Keine Produkte. Nutze `/track <ean>`.' };
    const groups = track.groupProducts(watches);
    const lines = groups.map((g) => {
      const cap = g.caps.find((c) => c != null);
      const head = `${g.anyEnabled ? '🟢' : '⏸️'} **${g.label || g.ident}** — ${g.kind.toUpperCase()} \`${g.ident}\`${cap != null ? ` · ≤${cap}€` : ''}`;
      return `${head}\n   ${g.sites.length} Shops: ${clip(g.sites.join(', '), 200)}`;
    });
    return { flags: FLAG_EPHEMERAL, embeds: [{ title: `📦 Produkte (${groups.length})`, description: clip(lines.join('\n\n'), 3900), color: 0x5865f2 }] };
  }

  // ── component interactions (selects/buttons) ───────────────────────────────────
  async function onComponent(it) {
    const id = it.data?.custom_id || '';
    const values = it.data?.values || [];

    // ── /add: Pool → (paginierte) Shop-Auswahl → Modus → Modal ─────────────────
    // Step 1 → 2: Pool gewählt → erste Shop-Seite
    if (id === 'add:pool') {
      const s = getSession(it) || newSession(it);
      s.pool = values[0];
      s.page = 0;
      s.selected = [];
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, stripFlags(flow.siteSelectMessage(s.pool, s.page, s.selected)));
    }
    // Step 2: Auswahl auf DIESER Seite übernehmen (Auswahl anderer Seiten bleibt)
    if (id === 'add:sites') {
      const s = getSession(it);
      if (!s || !s.pool) return rest.respond(it, CALLBACK.UPDATE_MESSAGE, EXPIRED);
      const pageKeys = new Set(catalogPageKeys(s.pool, s.page));
      const keep = s.selected.filter((k) => !pageKeys.has(k)); // andere Seiten
      s.selected = [...new Set([...keep, ...values])];
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, stripFlags(flow.siteSelectMessage(s.pool, s.page, s.selected)));
    }
    // Step 2: blättern
    if (id === 'add:page:prev' || id === 'add:page:next') {
      const s = getSession(it);
      if (!s || !s.pool) return rest.respond(it, CALLBACK.UPDATE_MESSAGE, EXPIRED);
      const pages = flow.pageCount(s.pool);
      s.page = (s.page + (id.endsWith('next') ? 1 : pages - 1)) % pages; // wrap-around
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, stripFlags(flow.siteSelectMessage(s.pool, s.page, s.selected)));
    }
    // Step 2: alle Shops des Pools auf einmal
    if (id === 'add:all') {
      const s = getSession(it);
      if (!s || !s.pool) return rest.respond(it, CALLBACK.UPDATE_MESSAGE, EXPIRED);
      s.selected = sitesInPool(s.pool).map((x) => x.key);
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, stripFlags(flow.siteSelectMessage(s.pool, s.page, s.selected)));
    }
    if (id === 'add:cancel') {
      sessions.delete(uidOf(it));
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, { content: '✖️ Abgebrochen.', components: [], embeds: [] });
    }
    // Step 2 → 3: weiter mit der gesammelten Auswahl
    if (id === 'add:next') {
      const s = getSession(it);
      if (!s || !s.pool) return rest.respond(it, CALLBACK.UPDATE_MESSAGE, EXPIRED);
      if (!s.selected.length) {
        return rest.respond(it, CALLBACK.UPDATE_MESSAGE, stripFlags({
          ...flow.siteSelectMessage(s.pool, s.page, s.selected),
          content: '⚠️ Noch kein Shop gewählt — wähle mindestens einen (oder „Alle im Pool").'
        }));
      }
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, stripFlags(flow.modeChoiceMessage(s.selected)));
    }
    // Step 3 → 4: Ident-Modal (Keys kommen aus der Session, nicht aus der custom_id)
    if (id === 'add:mode:single' || id === 'add:mode:multi') {
      const s = getSession(it);
      if (!s || !s.selected.length) return rest.respond(it, CALLBACK.UPDATE_MESSAGE, EXPIRED);
      s.mode = id.endsWith('multi') ? 'multi' : 'single';
      return rest.respond(it, CALLBACK.MODAL, flow.buildIdentModal(s.selected, s.mode));
    }
    // Step 4.5 → 5: open the price modal
    if (id.startsWith('add:pricestep:')) {
      const mode = id.slice('add:pricestep:'.length);
      return rest.respond(it, CALLBACK.MODAL, flow.buildPriceModal(mode));
    }
    // Step 3.5 → done without prices
    if (id === 'add:nopricestep') {
      const s = getSession(it);
      if (!s) return rest.respond(it, CALLBACK.UPDATE_MESSAGE, { content: '⏱️ Sitzung abgelaufen — bitte `/add` neu starten.', components: [] });
      return finalizeAdd(it, s, '', CALLBACK.UPDATE_MESSAGE);
    }
    if (id === 'remove:pick') {
      const ok = store.removeWatch(values[0]);
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, { content: ok ? `🗑️ Gelöscht: \`${values[0]}\`` : `Nicht gefunden: \`${values[0]}\``, components: [] });
    }
    if (id === 'toggle:off' || id === 'toggle:on') {
      const on = id === 'toggle:on';
      const ok = store.setEnabled(values[0], on);
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, { content: ok ? `${on ? '▶️ Aktiviert' : '⏸️ Pausiert'}: \`${values[0]}\`` : `Nicht gefunden: \`${values[0]}\``, components: [] });
    }
    if (id === 'interval:pick') {
      const w = store.findWatch(values[0]);
      return rest.respond(it, CALLBACK.MODAL, flow.buildIntervalModal(values[0], w?.pollMinutes));
    }
    if (id === 'pricedrop:pick') {
      const w = store.findWatch(values[0]);
      return rest.respond(it, CALLBACK.MODAL, flow.buildPriceDropModal(values[0], w?.trackPriceDrops ? (w.minDropPercent ?? config.defaults?.minDropPercent ?? 20) : 0));
    }
    if (id === 'channel:pick') {
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, flow.channelSelectMessage(values[0]));
    }
    if (id.startsWith('channel:set:')) {
      const watchId = id.slice('channel:set:'.length);
      const channelId = values[0];
      const ok = store.updateWatch(watchId, { channelId });
      return rest.respond(it, CALLBACK.UPDATE_MESSAGE, { content: ok ? `📣 Alerts für \`${watchId}\` gehen jetzt nach <#${channelId}>.` : `Nicht gefunden: \`${watchId}\``, components: [] });
    }
    if (id === 'check:pick') {
      // network work → ack first, then edit the original message with the result
      await rest.respond(it, CALLBACK.UPDATE_MESSAGE, { content: '🔄 Prüfe…', components: [] });
      let lines = ['(keine checkNow-Funktion verfügbar)'];
      try { if (hooks.checkNow) lines = await hooks.checkNow(values[0] === '*' ? null : [values[0]]); }
      catch (err) { lines = [`Fehler: ${err.message}`]; }
      return rest.editOriginal(it, { content: clip('🔄 **Sofort-Check**\n' + lines.join('\n'), 1900) });
    }
    return rest.respond(it, CALLBACK.DEFERRED_UPDATE);
  }

  // ── modal submits ──────────────────────────────────────────────────────────────
  async function onModal(it) {
    const id = it.data?.custom_id || '';
    const v = modalValues(it.data);

    // Step 4 submit: identifiers entered → in die Session, dann Preis-Schritt
    if (id.startsWith('add:idmodal:')) {
      const mode = id.endsWith('multi') ? 'multi' : 'single';
      const s = getSession(it);
      if (!s || !s.selected.length) return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: '⏱️ Sitzung abgelaufen — bitte `/add` neu starten.' });
      const idents = { ean: v.ean, pid: v.pid, asin: v.asin, url: v.url, query: v.query };
      const count = ['ean', 'pid', 'asin', 'url', 'query'].reduce((n, k) => n + flow._internal.splitList(idents[k]).length, 0);
      if (!count) return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: '❌ Keine gültige ID erkannt — bitte `/add` neu starten.' });
      s.mode = mode;
      s.idents = idents;
      return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, flow.priceStepMessage(mode, count));
    }
    // Step 4 submit: prices entered → create the watches
    if (id === 'add:pricemodal') {
      const s = getSession(it);
      if (!s) return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: '⏱️ Sitzung abgelaufen — bitte `/add` neu starten.' });
      return finalizeAdd(it, s, v.price || '', CALLBACK.CHANNEL_MESSAGE);
    }
    if (id.startsWith('interval:modal:')) {
      const watchId = id.slice('interval:modal:'.length);
      const mins = Math.max(1, Math.round(Number(String(v.minutes).replace(',', '.')) || 0));
      if (!mins) return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: '❌ Ungültige Minutenzahl.' });
      const ok = store.updateWatch(watchId, { pollMinutes: mins });
      return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: ok ? `⏱️ \`${watchId}\` wird jetzt alle **${mins} min** geprüft.` : `Nicht gefunden: \`${watchId}\`` });
    }
    if (id.startsWith('pricedrop:modal:')) {
      const watchId = id.slice('pricedrop:modal:'.length);
      const pct = Math.round(Number(String(v.percent || '').replace(',', '.')) || 0);
      const patch = pct > 0 ? { trackPriceDrops: true, minDropPercent: pct } : { trackPriceDrops: false };
      const ok = store.updateWatch(watchId, patch);
      return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: ok ? (pct > 0 ? `📉 Preis-Drop-Alarm für \`${watchId}\` aktiv ab **−${pct}%**.` : `📉 Preis-Drop-Alarm für \`${watchId}\` **aus**.`) : `Nicht gefunden: \`${watchId}\`` });
    }
    if (id === 'import:modal') {
      return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, embeds: [importJson(v.json)] });
    }
    return rest.respond(it, CALLBACK.CHANNEL_MESSAGE, { flags: FLAG_EPHEMERAL, content: 'OK' });
  }

  // ── /add helpers ───────────────────────────────────────────────────────────────
  // For a type-7 message UPDATE the ephemeral flag can't be (re)set, so drop it.
  function stripFlags(msg) { const { flags, ...rest } = msg; return rest; }

  // Final step: build + persist the watches from the collected session + prices.
  async function finalizeAdd(it, s, priceRaw, callbackType) {
    const inputs = { ...s.idents, price: priceRaw };
    const { partials, warnings } = flow.buildWatchPartials(s.selected, inputs);
    const { created, skipped } = store.addWatches(partials);
    sessions.delete(uidOf(it));
    const data = callbackType === CALLBACK.UPDATE_MESSAGE
      ? { content: '', embeds: [addSummaryEmbed(created, skipped, warnings)], components: [] }
      : { flags: FLAG_EPHEMERAL, embeds: [addSummaryEmbed(created, skipped, warnings)] };
    return rest.respond(it, callbackType, data);
  }

  // ── message builders ─────────────────────────────────────────────────────────
  function listMessage() {
    const watches = store.listWatches();
    if (!watches.length) return { flags: FLAG_EPHEMERAL, content: '📭 Keine Produkte konfiguriert. Nutze `/track` oder `/add`.' };
    const botOnly = store.load().defaults?.botWatchesOnly === true;
    const lines = watches.map((w) => {
      const ident = w.ean ? `EAN ${w.ean}` : w.pid ? `PID ${w.pid}` : w.asin ? `ASIN ${w.asin}` : w.url ? clip(w.url, 50) : '?';
      const dormant = botOnly && w.source !== 'bot';
      const flags = [dormant ? '💤' : (w.enabled === false ? '⏸️' : '🟢'), w.trackPriceDrops ? '📉' : null, w.channelId ? `📣<#${w.channelId}>` : null].filter(Boolean).join(' ');
      const poll = w.pollMinutes ? ` · ${w.pollMinutes}min` : '';
      return `${flags} **${w.site}** — ${ident}${fmtCap(w)}${poll}  \`${w.id}\``;
    });
    const legend = botOnly ? '\n\n_💤 = wird derzeit nicht überwacht (nicht per Bot angelegt). 🟢 aktiv · ⏸️ pausiert · 📉 Preis-Drop · 📣 eigener Channel._' : '';
    return { flags: FLAG_EPHEMERAL, embeds: [{ title: `📋 Watchlist (${watches.length})`, description: clip(lines.join('\n') + legend, 3900), color: 0x5865f2 }] };
  }

  function addSummaryEmbed(created, skipped, warnings) {
    const lines = [];
    if (created.length) {
      lines.push(`✅ **${created.length} hinzugefügt:**`);
      for (const w of created) lines.push(`• **${w.site}** — ${w.ean || w.pid || w.asin || clip(w.url, 50)}${fmtCap(w)}  \`${w.id}\``);
    }
    if (skipped.length) { lines.push(`\n♻️ **${skipped.length} schon vorhanden** (übersprungen).`); }
    for (const w of warnings) lines.push(`⚠️ ${w}`);
    if (!lines.length) lines.push('Nichts hinzugefügt.');
    return { title: '🛒 Produkt(e) hinzugefügt', description: clip(lines.join('\n'), 3900), color: created.length ? 0x22c55e : 0xeab308 };
  }

  function exportMessage() {
    const json = JSON.stringify(store.listWatches(), null, 2);
    if (json.length <= 1850) return { flags: FLAG_EPHEMERAL, content: '📤 **Watchlist-Export:**\n```json\n' + json + '\n```' };
    return { flags: FLAG_EPHEMERAL, content: `📤 Die Watchlist ist zu groß für eine Nachricht (${json.length} Zeichen). Sie liegt in \`online_monitor/config.json\` unter "watches".` };
  }

  function importJson(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) { return { title: '❌ Import fehlgeschlagen', description: `Kein gültiges JSON: ${err.message}`, color: 0xef4444 }; }
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.watches) ? parsed.watches : null;
    if (!arr) return { title: '❌ Import fehlgeschlagen', description: 'Erwartet wird ein Array oder ein Objekt mit "watches".', color: 0xef4444 };
    const valid = arr.filter((w) => w && w.site && (w.ean || w.pid || w.asin || w.url));
    const { created, skipped } = store.addWatches(valid);
    const lines = [`✅ ${created.length} importiert, ♻️ ${skipped.length} schon vorhanden, ⚠️ ${arr.length - valid.length} ungültig.`];
    for (const w of created.slice(0, 20)) lines.push(`• \`${w.id}\``);
    return { title: '📥 Import', description: clip(lines.join('\n'), 3900), color: 0x22c55e };
  }

  gw.connect();
  return { shutdown: async () => gw.destroy() };
}

module.exports = { startBot };
