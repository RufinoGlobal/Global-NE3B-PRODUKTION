// Verifies that the deployed API contains exactly the data of the source JSON.
// Deep-compares every record (lists incl. every row, belege, over, extra,
// extraAreas) between the source file and GET <base>/api/bootstrap.
//
// Usage: node scripts/verify-migration.mjs <base-url> [source.json]
import fs from 'node:fs';

const base = process.argv[2];
const src = process.argv[3] || 'NE3-DATEN-NICHT-LOESCHEN.json';
if (!base) {
  console.error('Usage: node scripts/verify-migration.mjs <base-url> [source.json]');
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(src, 'utf8'));
const res = await fetch(new URL('/api/bootstrap', base));
if (!res.ok) {
  console.error(`FEHLER: /api/bootstrap → HTTP ${res.status}`);
  process.exit(1);
}
const boot = await res.json();
const remote = { list: {}, belege: {}, over: {}, meta: {} };
for (const rec of boot.records) remote[rec.type][rec.key] = rec.data;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fails = 0;
const fail = (msg) => { fails++; console.error('FAIL: ' + msg); };

// --- lists: every PDP, every row ---
const srcLists = d.lists || {};
for (const [pdp, list] of Object.entries(srcLists)) {
  const r = remote.list[pdp];
  if (!r) { fail(`Liste ${pdp} fehlt in D1`); continue; }
  if (!eq(list.meta, r.meta)) fail(`Liste ${pdp}: meta weicht ab`);
  if ((list.rows || []).length !== (r.rows || []).length) {
    fail(`Liste ${pdp}: Zeilenzahl ${list.rows.length} ≠ ${(r.rows || []).length}`);
  } else if (!eq(list.rows, r.rows)) {
    fail(`Liste ${pdp}: Zeileninhalt weicht ab`);
  }
}
// --- belege ---
for (const [pdp, bel] of Object.entries(d.belege || {})) {
  if (!eq(bel, remote.belege[pdp])) fail(`Belege ${pdp} weichen ab`);
}
// --- over ---
for (const [pdp, o] of Object.entries(d.over || {})) {
  if (!eq(o, remote.over[pdp])) fail(`Überschreibung ${pdp} weicht ab`);
}
// --- meta ---
if (!eq(d.extra || {}, remote.meta.extra)) fail('extra weicht ab');
if (!eq(d.extraAreas || [], remote.meta.extraAreas)) fail('extraAreas weicht ab');

// --- counts summary ---
const srcRowCount = Object.values(srcLists).reduce((s, l) => s + (l.rows || []).length, 0);
const dstLists = Object.keys(remote.list).length;
const dstRowCount = Object.values(remote.list).reduce((s, l) => s + (l.rows || []).length, 0);
const srcBelegCount = Object.values(d.belege || {}).reduce((s, b) => s + b.length, 0);
const dstBelegCount = Object.values(remote.belege).reduce((s, b) => s + b.length, 0);
console.log(`Quelle : ${Object.keys(srcLists).length} PDP-Listen, ${srcRowCount} Zeilen, ${Object.keys(d.belege || {}).length} Beleg-Gruppen (${srcBelegCount} Belege), extra=${Object.keys(d.extra || {}).length}, extraAreas=${(d.extraAreas || []).length}`);
console.log(`Ziel   : ${dstLists} PDP-Listen, ${dstRowCount} Zeilen, ${Object.keys(remote.belege).length} Beleg-Gruppen (${dstBelegCount} Belege), extra=${Object.keys(remote.meta.extra || {}).length}, extraAreas=${(remote.meta.extraAreas || []).length}`);

if (fails) {
  console.error(`VERIFIKATION FEHLGESCHLAGEN: ${fails} Abweichung(en)`);
  process.exit(1);
}
console.log('VERIFIKATION BESTANDEN: alle Datensätze stimmen mit der Quelle überein.');
