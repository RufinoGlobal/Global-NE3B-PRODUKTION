// Regression tests for the derived GESPERRT gate (Prozess 1 / Prozess 2).
//
// The rules are extracted from the shipped public/index.html logic block, so
// these tests always run against the real production code — not a copy.
// Prozess 1 gate: NE3B Abnahme Protokoll (p51). Prozess 2 gate: HÜP Protokoll (p61).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('type="text/x-dc"');
const src = html.slice(html.indexOf('>', start) + 1, html.indexOf('</script>', start));

// Pull out only the pure helper definitions we want to exercise.
const grab = (name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `Helper ${name} fehlt im Frontend`);
  const open = src.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(at, i + 1);
};
const numDef = src.slice(src.indexOf('const num ='), src.indexOf('\n', src.indexOf('const num =')));
const gate = new Function(
  `${numDef}
   ${grab('hasP1Production')} ${grab('isP1Locked')}
   ${grab('hasP2Production')} ${grab('isP2Locked')}
   ${grab('accumulateRow')}
   return { num, hasP1Production, isP1Locked, hasP2Production, isP2Locked, accumulateRow };`
)();

const row = (over = {}) => Object.assign({
  addr: '', ha: false, he: false, p51: false, state1: 'open',
  huep: false, gf: '', mfg: '', pdp: '', haus: '', otdr: '', p61: false, state2: 'open',
}, over);

// ---------------- Prozess 1 ----------------

test('P1 Test 1: HA ohne OXG5.1 → gesperrt', () => {
  assert.equal(gate.isP1Locked(row({ ha: true })), true);
});

test('P1 Test 2 (Bugfix): HE allein ohne OXG5.1 → gesperrt', () => {
  assert.equal(gate.isP1Locked(row({ he: true })), true);
});

test('P1 Test 2b: HA + HE ohne OXG5.1 → gesperrt', () => {
  assert.equal(gate.isP1Locked(row({ ha: true, he: true })), true);
});

test('P1 Test 3: HA + HE + OXG5.1 → nicht gesperrt', () => {
  assert.equal(gate.isP1Locked(row({ ha: true, he: true, p51: true })), false);
});

test('P1: HE + OXG5.1 → nicht gesperrt', () => {
  assert.equal(gate.isP1Locked(row({ he: true, p51: true })), false);
});

test('P1: keine Produktion → nicht gesperrt (auch ohne OXG5.1)', () => {
  assert.equal(gate.isP1Locked(row()), false);
});

test('P1 Test 4: ALLE-HE über mehrere Zeilen → jede Zeile ohne OXG5.1 gesperrt', () => {
  const rows = [row(), row(), row({ p51: true })];
  const afterBulk = rows.map((r) => Object.assign({}, r, { he: true })); // toggleAllCol('he')
  assert.deepEqual(afterBulk.map(gate.isP1Locked), [true, true, false]);
});

test('P1 Test 12/13: Produktion entfernt → Sperre fällt weg', () => {
  assert.equal(gate.isP1Locked(row({ ha: false, he: false })), false);
});

// ---------------- Prozess 2 ----------------

test('P2 Test 5 (Bugfix): GF Kabel 158,9 ohne OXG6.1 → gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ gf: '158,9' })), true);
});

test('P2: kleine GF-Mengen zählen ebenfalls', () => {
  for (const gf of ['108,2', '1', '0,1']) {
    assert.equal(gate.isP2Locked(row({ gf })), true, `GF ${gf} muss sperren`);
  }
});

test('P2 Test 6: Spleiß MFG ohne OXG6.1 → gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ mfg: 1 })), true);
});

test('P2 Test 7: Spleiß PDP ohne OXG6.1 → gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ pdp: 5 })), true);
});

test('P2 Test 8: Spleiß Haus ohne OXG6.1 → gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ haus: 5 })), true);
});

test('P2 Test 9: OTDR ohne OXG6.1 → gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ otdr: 10 })), true);
});

test('P2 Test 10: HÜP montiert, alle Zahlen 0, ohne OXG6.1 → gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ huep: true, gf: 0, mfg: 0, pdp: 0, haus: 0, otdr: 0 })), true);
});

test('P2 Test 11: GF 158,9 mit OXG6.1 → nicht gesperrt', () => {
  assert.equal(gate.isP2Locked(row({ gf: '158,9', p61: true })), false);
});

test('P2 Test 12: Nullen/leere Felder sind keine Produktion', () => {
  assert.equal(gate.isP2Locked(row({ gf: '0,0', mfg: 0, pdp: 0, haus: 0, otdr: 0 })), false);
  assert.equal(gate.isP2Locked(row({ gf: '', mfg: '', pdp: '', haus: '', otdr: '' })), false);
  assert.equal(gate.isP2Locked(row({ gf: '0' })), false);
});

test('P2 Test 13: GF wieder geleert → Sperre fällt weg', () => {
  const locked = row({ gf: '158,9' });
  assert.equal(gate.isP2Locked(locked), true);
  assert.equal(gate.isP2Locked(Object.assign({}, locked, { gf: '' })), false);
});

// ---------------- Buchung / Summen ----------------

const emptyAcc = () => ({ HA: [0, 0, 0], '5.1': [0, 0, 0], '6.1': [0, 0, 0], '6.4': [0, 0, 0], '6.2': [0, 0, 0], '6.3': [0, 0, 0] });
const slotOf = (st) => (st === 'new' ? 0 : st === 'sent' ? 1 : -1);

test('Buchung: gesperrtes GF Kabel landet in GESPERRT, nicht in NEU', () => {
  const acc = emptyAcc();
  gate.accumulateRow(acc, row({ state2: 'new', gf: '158,9' }), slotOf);
  assert.equal(acc['6.4'][0], 0, 'darf nicht als neu abrechenbar gelten');
  assert.equal(acc['6.4'][2], 158.9, 'muss in der GESPERRT-Spalte stehen');
});

test('Buchung: freigegebenes GF Kabel bleibt in NEU', () => {
  const acc = emptyAcc();
  gate.accumulateRow(acc, row({ state2: 'new', gf: '158,9', p61: true }), slotOf);
  assert.equal(acc['6.4'][0], 158.9);
  assert.equal(acc['6.4'][2], 0);
});

test('Buchung: gesperrte Spleiße und OTDR landen in GESPERRT', () => {
  const acc = emptyAcc();
  gate.accumulateRow(acc, row({ state2: 'new', mfg: 2, pdp: 1, haus: 1, otdr: 3 }), slotOf);
  assert.equal(acc['6.2'][2], 4);
  assert.equal(acc['6.3'][2], 3);
  assert.equal(acc['6.2'][0], 0);
  assert.equal(acc['6.3'][0], 0);
});

test('Buchung: HE-gesperrter Hausanschluss zählt als GESPERRT', () => {
  const acc = emptyAcc();
  gate.accumulateRow(acc, row({ state1: 'new', ha: true, he: true }), slotOf);
  assert.equal(acc.HA[0], 0);
  assert.equal(acc.HA[2], 1);
});

test('Buchung: freigegebener Hausanschluss zählt als NEU', () => {
  const acc = emptyAcc();
  gate.accumulateRow(acc, row({ state1: 'new', ha: true, p51: true }), slotOf);
  assert.equal(acc.HA[0], 1);
  assert.equal(acc['5.1'][0], 1);
  assert.equal(acc.HA[2], 0);
});

// ---------------- Datenmodell ----------------

test('GESPERRT ist kein gespeicherter Status – Zyklus bleibt vierstufig', () => {
  const cycle = src.slice(src.indexOf('const CYCLE ='), src.indexOf('\n', src.indexOf('const CYCLE =')));
  assert.match(cycle, /\['new', 'sent', 'open', 'storno'\]/);
  assert.ok(!cycle.includes('gesperrt'), 'gesperrt darf nicht im persistierten Zyklus stehen');
});

test('Anzeige und PNG-Export nutzen dieselbe Gate-Regel', () => {
  const uses = (src.match(/isP1Locked\(r\)/g) || []).length;
  const uses2 = (src.match(/isP2Locked\(r\)/g) || []).length;
  assert.ok(uses >= 3, 'isP1Locked muss in Tabelle, Export und Buchung verwendet werden');
  assert.ok(uses2 >= 3, 'isP2Locked muss in Tabelle, Export und Buchung verwendet werden');
  assert.ok(src.includes('BLOCKED_BADGE'), 'gemeinsames GESPERRT-Badge muss existieren');
});

// ---------------- Anzeige: Status + zusätzliches GESPERRT-Badge -------------
// Der normale Status bleibt das primäre Pill; GESPERRT ist ein separates
// rotes Badge daneben und ersetzt den Status niemals.

const displayOf = (r) => {
  const palette = { new: 'NEU', sent: 'EINGEREICHT', open: 'OFFEN', storno: 'STORNO' };
  return {
    p1: [palette[r.state1] || 'OFFEN'].concat(gate.isP1Locked(r) ? ['GESPERRT'] : []),
    p2: [palette[r.state2] || 'OFFEN'].concat(gate.isP2Locked(r) ? ['GESPERRT'] : []),
  };
};

test('Anzeige Test 1: OFFEN + GF ohne OXG6.1 → [OFFEN] [GESPERRT]', () => {
  assert.deepEqual(displayOf(row({ state2: 'open', gf: '158,9' })).p2, ['OFFEN', 'GESPERRT']);
});

test('Anzeige Test 2: NEU + GF ohne OXG6.1 → [NEU] [GESPERRT]', () => {
  assert.deepEqual(displayOf(row({ state2: 'new', gf: '158,9' })).p2, ['NEU', 'GESPERRT']);
});

test('Anzeige: EINGEREICHT + Spleiß PDP ohne OXG6.1 → [EINGEREICHT] [GESPERRT]', () => {
  assert.deepEqual(displayOf(row({ state2: 'sent', pdp: 5 })).p2, ['EINGEREICHT', 'GESPERRT']);
});

test('Anzeige Test 3: OFFEN + HE ohne OXG5.1 → [OFFEN] [GESPERRT]', () => {
  assert.deepEqual(displayOf(row({ state1: 'open', he: true })).p1, ['OFFEN', 'GESPERRT']);
});

test('Anzeige: P1 behält jeden gespeicherten Status neben GESPERRT', () => {
  for (const [st, label] of [['new', 'NEU'], ['sent', 'EINGEREICHT'], ['open', 'OFFEN'], ['storno', 'STORNO']]) {
    assert.deepEqual(displayOf(row({ state1: st, he: true })).p1, [label, 'GESPERRT']);
  }
});

test('Anzeige Test 4: Protokoll gesetzt → nur der normale Status bleibt', () => {
  assert.deepEqual(displayOf(row({ state2: 'open', gf: '158,9', p61: true })).p2, ['OFFEN']);
  assert.deepEqual(displayOf(row({ state1: 'new', he: true, p51: true })).p1, ['NEU']);
});

test('Anzeige Test 5: GESPERRT-Badge ist rot und ersetzt kein Status-Pill', () => {
  assert.match(src, /BLOCKED_BADGE = \{ label: 'GESPERRT', red: '#c2182f' \}/);
  // Das Status-Pill nutzt weiterhin ausschließlich die Status-Palette.
  assert.match(src, /const p1 = palette\[r\.state1\] \|\| palette\.open/);
  assert.match(src, /const p2 = palette\[r\.state2\] \|\| palette\.open/);
  assert.ok(!src.includes('BLOCKED_PALETTE'), 'kein Status-überschreibendes Pill mehr');
  // Rotes Badge im Template, kein Status in Klammern.
  const html2 = html.slice(html.indexOf('<x-dc>'), html.indexOf('type="text/x-dc"'));
  assert.equal((html2.match(/background:#c2182f;color:#fff;font-size:10px;font-weight:700/g) || []).length, 2,
    'rotes GESPERRT-Badge muss in Status P1 und P2 stehen');
  assert.ok(!html2.includes('({{ r.under1Label }})'), 'Status darf nicht in Klammern erscheinen');
});

test('Anzeige Test 6: Status-Pill bleibt klickbar, Badge nicht', () => {
  const html2 = html.slice(html.indexOf('<x-dc>'), html.indexOf('type="text/x-dc"'));
  assert.ok(html2.includes('sc-camel-on-click="{{ r.cycle1 }}"'), 'P1-Pill muss klickbar bleiben');
  assert.ok(html2.includes('sc-camel-on-click="{{ r.cycle2 }}"'), 'P2-Pill muss klickbar bleiben');
  const badges = html2.split('>GESPERRT</span>');
  assert.equal(badges.length, 3, 'genau zwei GESPERRT-Badges');
  for (const before of badges.slice(0, 2)) {
    const tag = before.slice(before.lastIndexOf('<span'));
    assert.ok(!tag.includes('sc-camel-on-click'), 'GESPERRT-Badge darf nicht klickbar sein');
  }
});

test('Anzeige Test 7: PNG-Export nutzt dieselbe Zwei-Badge-Darstellung', () => {
  const png = src.slice(src.indexOf('renderListPng()'));
  assert.match(png, /const locked = c\.status === 'state1' \? lk1 : lk2/);
  assert.match(png, /ctx\.fillStyle = BLOCKED_BADGE\.red/);
  assert.match(png, /ctx\.fillText\(BLOCKED_BADGE\.label/);
  assert.match(png, /const p1 = palette\[r\.state1\] \|\| palette\.open/);
});

test('PNG behält die feste Gesamtbreite (Spaltensumme 1400 + 2×40 Rand)', () => {
  const colsSrc = src.slice(src.indexOf('const cols = ['), src.indexOf('];', src.indexOf('const cols = [')));
  const sum = [...colsSrc.matchAll(/w: (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  assert.equal(sum, 1400, 'Spaltensumme muss konstant bleiben');
  assert.match(src, /SCALE = 2, W = 1480, M = 40/);
});

test('Excel nutzt weiterhin den gespeicherten Status, nicht GESPERRT', () => {
  const xls = src.slice(src.indexOf('exportNeueExcel()'), src.indexOf('exportBaseName()'));
  assert.match(xls, /new:'Neu', sent:'Eingereicht', open:'Offen', storno:'Storno'/);
  assert.ok(!xls.includes('GESPERRT'), 'Excel-Status darf nicht durch GESPERRT ersetzt werden');
  assert.match(xls, /r\.state1 === 'new' \|\| r\.state2 === 'new'/, 'Neue-Produktion-Filter unverändert');
});
