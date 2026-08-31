// Integration tests for the Worker API against a local `wrangler dev` instance
// with a local D1 database (never against production).
//
// The harness starts `wrangler dev` itself (applying local migrations first),
// waits for /api/health, runs the tests and kills the process tree afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';

const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
let devProc;

const api = async (path, init) => {
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
};
const put = (type, key, data, baseRev) =>
  api(`/api/record/${type}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, baseRev }),
  });

before(async () => {
  execSync('npx wrangler d1 migrations apply global-ne3b-production --local', {
    stdio: 'pipe', shell: true,
  });
  devProc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
    stdio: 'pipe', shell: true,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('wrangler dev wurde nicht rechtzeitig bereit');
    await new Promise((r) => setTimeout(r, 750));
  }
});

after(() => {
  if (devProc?.pid) {
    try { execSync(`taskkill /pid ${devProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
});

test('health check', async () => {
  const { status, body } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.db, 'ok');
});

test('create record with baseRev 0', async () => {
  const key = 'TESTPDP' + Date.now();
  const data = { meta: { mfg: '1', datum: '01.01.26' }, rows: [{ addr: 'Teststraße 1', ha: true }] };
  const { status, body } = await put('list', key, data, 0);
  assert.equal(status, 200);
  assert.equal(body.rev, 1);
  assert.deepEqual(body.data, data);
});

test('update with correct baseRev increments rev', async () => {
  const key = 'TESTUPD' + Date.now();
  await put('list', key, { meta: {}, rows: [] }, 0);
  const { status, body } = await put('list', key, { meta: {}, rows: [{ addr: 'Neu' }] }, 1);
  assert.equal(status, 200);
  assert.equal(body.rev, 2);
});

test('stale baseRev returns 409 with the current server record (no silent overwrite)', async () => {
  const key = 'TESTCONFLICT' + Date.now();
  await put('list', key, { meta: {}, rows: [{ addr: 'Nutzer A' }] }, 0);   // rev 1
  await put('list', key, { meta: {}, rows: [{ addr: 'Nutzer B' }] }, 1);   // rev 2
  const { status, body } = await put('list', key, { meta: {}, rows: [{ addr: 'Nutzer A alt' }] }, 1);
  assert.equal(status, 409);
  assert.equal(body.rev, 2);
  assert.equal(body.data.rows[0].addr, 'Nutzer B', 'Server muss die neuere Version behalten');
});

test('two different PDPs never conflict', async () => {
  const a = 'TESTA' + Date.now(), b = 'TESTB' + Date.now();
  const [ra, rb] = await Promise.all([
    put('list', a, { meta: {}, rows: [{ addr: 'A' }] }, 0),
    put('list', b, { meta: {}, rows: [{ addr: 'B' }] }, 0),
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.notEqual(ra.body.seq, rb.body.seq, 'seq muss global eindeutig sein');
});

test('changes feed returns records newer than since', async () => {
  const key = 'TESTCHG' + Date.now();
  const before = await api('/api/health');
  await put('belege', key, [{ nr: '123', has: 1, gf: 0, splice: 0, otdr: 0, huep: 0 }], 0);
  const { status, body } = await api('/api/changes?since=' + before.body.seq);
  assert.equal(status, 200);
  assert.ok(body.records.some((r) => r.type === 'belege' && r.key === key));
});

test('bootstrap contains written records', async () => {
  const key = 'TESTBOOT' + Date.now();
  await put('over', key, { has: 5 }, 0);
  const { status, body } = await api('/api/bootstrap');
  assert.equal(status, 200);
  const rec = body.records.find((r) => r.type === 'over' && r.key === key);
  assert.ok(rec);
  assert.equal(rec.data.has, 5);
});

test('invalid type and malformed payloads are rejected', async () => {
  assert.equal((await put('sqlinject', 'X', {}, 0)).status, 400);
  assert.equal((await put('meta', 'nichtErlaubt', {}, 0)).status, 400);
  assert.equal((await put('list', 'BAD KEY!', {}, 0)).status, 400);
  assert.equal((await put('list', 'TESTVAL', { keineRows: true }, 0)).status, 400);
  assert.equal((await put('belege', 'TESTVAL', { nichtListe: 1 }, 0)).status, 400);
});

test('backup export has the GGB-NE3 shape', async () => {
  const res = await fetch(BASE + '/api/backup');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /NE3-DATEN-NICHT-LOESCHEN\.json/);
  const b = await res.json();
  assert.equal(b.app, 'GGB-NE3');
  assert.equal(b.version, 1);
  for (const k of ['lists', 'belege', 'over', 'extra', 'extraAreas']) assert.ok(k in b);
});

test('frontend is served with noindex and without PIN', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('noindex,nofollow'));
  assert.ok(!html.includes("'1374'"), 'PIN darf nicht mehr im Frontend stehen');
  assert.ok(html.includes('/api/bootstrap'), 'Cloud-Bootstrap muss eingebaut sein');
});

test('header has combined export, no backup/print controls', async () => {
  const res = await fetch(BASE + '/');
  const html = await res.text();
  assert.ok(html.includes('Export: Foto + Excel'), 'kombinierter Export-Button muss existieren');
  assert.ok(!html.includes('Backup herunterladen'), 'Backup-Download-Button muss entfernt sein');
  assert.ok(!html.includes('Backup importieren'), 'Backup-Import-Button muss entfernt sein');
  assert.ok(!html.includes('Drucken / PDF'), 'PDF-Druck-Button muss entfernt sein');
  assert.ok(!html.includes('Alles drucken'), 'Alle-Gebiete-Druck muss entfernt sein');
  assert.ok(!html.includes('window.print'), 'kein programmatischer PDF-Druck mehr');
  assert.ok(html.includes('renderListPng'), 'PNG-Renderer muss eingebaut sein');
  assert.ok(html.includes('exportBaseName'), 'gemeinsame Dateinamen-Basis muss existieren');
});
