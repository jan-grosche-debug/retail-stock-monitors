// Per-Seite Status-Logger für den Online-Monitor.
// Append-only, wirft NIE (alles in try/catch), berührt die Monitor-Logik nicht.
//
// Schreibt zwei Dateien in online_monitor/:
//   - site-status.jsonl : eine JSON-Zeile pro Abruf (Verlauf, zum Auswerten)
//   - SITE-STATUS.md     : lesbare Tabelle, letzter Stand pro Seite (✅/❌/⏳)
//
// Aufgerufen aus index.js: status.record(watch, ok, grund) je Abruf,
// status.flush() einmal pro Tick (schreibt die Markdown-Tabelle).

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const JSONL = path.join(ROOT, 'site-status.jsonl');
const MD = path.join(ROOT, 'SITE-STATUS.md');

// site -> { ok, fail, lastResult, lastReason, lastAt, lastWatch, lastOkAt }
const sites = {};

function siteOf(watch) {
  return (watch && (watch.site || watch.kind || watch.type)) || 'unknown';
}

function record(watch, ok, reason) {
  try {
    const site = siteOf(watch);
    const at = new Date().toISOString();
    const s = sites[site] || (sites[site] = { ok: 0, fail: 0, lastOkAt: null });
    if (ok) { s.ok += 1; s.lastOkAt = at; } else { s.fail += 1; }
    s.lastResult = ok ? 'ok' : 'fail';
    s.lastReason = String(reason == null ? '' : reason).replace(/\s+/g, ' ').slice(0, 140);
    s.lastAt = at;
    s.lastWatch = watch && watch.id;
    fs.appendFile(JSONL, JSON.stringify({ at, site, watch: s.lastWatch, ok: !!ok, reason: s.lastReason }) + '\n', () => {});
  } catch (_) { /* never throw */ }
}

function flush() {
  try {
    const rows = Object.keys(sites).sort().map((site) => {
      const s = sites[site];
      const total = s.ok + s.fail;
      const rate = total ? Math.round((s.ok / total) * 100) : 0;
      const icon = s.lastResult === 'ok' ? '✅' : s.lastResult === 'fail' ? '❌' : '⏳';
      const reason = s.lastResult === 'fail' ? (s.lastReason || '') : '';
      const last = s.lastAt ? s.lastAt.replace('T', ' ').slice(0, 16) : '—';
      return `| ${icon} | \`${site}\` | ${s.ok} | ${s.fail} | ${rate}% | ${reason} | ${last} |`;
    });
    const md = [
      '# Online-Monitor — Seiten-Status',
      '',
      `_Automatisch aktualisiert: ${new Date().toLocaleString('de-DE')}_`,
      '',
      '| Status | Seite | OK | Fehler | Erfolgsquote | Letzter Fehler | Zuletzt (UTC) |',
      '|:--:|---|--:|--:|--:|---|---|',
      ...rows,
      '',
      '✅ = letzter Abruf erfolgreich · ❌ = letzter Abruf fehlgeschlagen (Proxy/Bot-Schutz) · ⏳ = noch kein Ergebnis',
    ].join('\n') + '\n';
    fs.writeFile(MD, md, () => {});
  } catch (_) { /* never throw */ }
}

module.exports = { record, flush };
