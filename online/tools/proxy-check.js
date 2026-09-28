// Proxy-Check — prüft JEDEN Exit im Pool einzeln, bevor der Monitor startet.
//
//   node tools/proxy-check.js
//
// Für jeden Proxy: Ausgangs-IP, Land/ISP, Latenz. So siehst du sofort, ob die
// ISPs überhaupt greifen (und ob sie wirklich als ISP/Residential durchgehen) —
// ohne einen einzigen Request auf idealo zu verbrennen.
//
// Exit-Code 0 = mindestens ein Proxy funktioniert, 1 = keiner.

const path = require('path');
const proxy = require('../proxy');
const { createRequestClient, shutdownCycle } = require(path.join(__dirname, '..', '..', 'AIOBot', 'modules', 'requestClient'));

// Bright Datas Geo-Endpoint liefert IP + Land + ASN/ISP in einem Call.
// Fallback: ipify (nur IP).
const GEO = 'https://geo.brdtest.com/mygeo.json';
const FALLBACK = 'https://api.ipify.org?format=json';

async function probe(p) {
  const client = createRequestClient({ useTls: true, timeout: 20000, proxy: { server: p.server } });
  const t0 = Date.now();
  try {
    let res = await client.get(GEO, { headers: { accept: 'application/json' } }).catch(() => null);
    let data = null;
    if (res && res.status < 400) { try { data = JSON.parse(String(res.data)); } catch (_) { /* noop */ } }
    if (!data) {
      res = await client.get(FALLBACK, { headers: { accept: 'application/json' } });
      try { data = JSON.parse(String(res.data)); } catch (_) { data = null; }
    }
    const ms = Date.now() - t0;
    if (!data) return { ok: false, ms, err: `unlesbare Antwort (status ${res && res.status})` };
    const ip = data.ip || data.query || '?';
    const country = data.country || (data.geo && data.geo.country) || '';
    const asn = (data.asn && (data.asn.asnum || data.asn)) || '';
    const org = (data.asn && data.asn.org_name) || data.org || '';
    return { ok: true, ms, ip, country, asn, org };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, err: err.message };
  }
}

async function main() {
  const list = proxy.listProxies();
  if (!list.length) {
    console.log('❌ Kein Proxy konfiguriert.');
    console.log('   → online_monitor/proxies.txt anlegen (eine Zeile pro Proxy) ODER');
    console.log('     "proxies": [ … ] in config.json setzen.');
    console.log('   Formate: host:port:user:pass | user:pass@host:port | http://user:pass@host:port');
    process.exit(1);
  }

  console.log(`🔌 Prüfe ${list.length} Proxy/Proxies…\n`);
  const results = [];
  for (const p of list) {
    const r = await probe(p);
    results.push({ p, r });
    if (r.ok) {
      const tag = [r.country, r.org || r.asn].filter(Boolean).join(' · ');
      console.log(`  ✅ ${p.id.padEnd(28)} → ${String(r.ip).padEnd(16)} ${tag ? '(' + tag + ')' : ''}  ${r.ms} ms`);
    } else {
      console.log(`  ❌ ${p.id.padEnd(28)} → ${r.err}  ${r.ms} ms`);
    }
  }

  const ok = results.filter((x) => x.r.ok);
  const ips = new Set(ok.map((x) => x.r.ip));
  console.log(`\n${ok.length}/${list.length} Proxies erreichbar · ${ips.size} unterschiedliche Ausgangs-IP(s)`);
  if (ok.length > 1 && ips.size === 1) {
    console.log('⚠️  Alle Exits landen auf DERSELBEN IP — das ist ein rotierendes Gateway, kein IP-Pool.');
    console.log('   Rotation bringt dann wenig: bei einem Block ist jeder „Exit" gleich verbrannt.');
  }
  await shutdownCycle().catch(() => null);
  process.exit(ok.length ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
