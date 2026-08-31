// Transforms the original Claude-Design export (NE3-Manager-preview.html)
// into the production frontend (public/index.html):
//   - PIN/lock gate removed (open-by-URL is an owner requirement)
//   - localStorage/file persistence replaced by the Worker/D1 cloud sync engine
//   - file buttons repurposed as backup download / backup import
//   - robots noindex meta added
// Every replacement asserts its exact expected occurrence count, so any drift
// in the source file fails loudly instead of producing a half-patched app.
//
// Usage: node scripts/patch-frontend.mjs [input.html] [output.html]
import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2] || 'NE3-Manager-preview.html';
const output = process.argv[3] || path.join('public', 'index.html');

let html = fs.readFileSync(input, 'utf8');
let applied = 0;

function patch(name, from, to, expected = 1) {
  const parts = html.split(from);
  const count = parts.length - 1;
  if (count !== expected) {
    console.error(`FEHLER: Patch "${name}" erwartet ${expected} Treffer, gefunden ${count}`);
    process.exit(1);
  }
  html = parts.join(to);
  applied++;
}

// ---------- head: keep search engines away (this is NOT authentication) ----------
patch(
  'robots-meta',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="robots" content="noindex,nofollow">\n<title>NE3 Manager – GLOBAL NE3B PRODUKTION</title>'
);

// ---------- constructor: restore only view preferences from localStorage ----------
patch(
  'constructor-saved-view-only',
  `    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}`,
  `    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (saved) saved = { view: saved.view, area: saved.area, sel: saved.sel, listArea: saved.listArea };`
);

// ---------- constructor: no PIN gate, sync status fields ----------
patch(
  'constructor-unlocked',
  `    this.state.unlocked = false;`,
  `    this.state.unlocked = true;
    this.state.sync = 'init';
    this.state.syncMsg = '';`
);

// ---------- componentDidMount: replace file-handle persistence with cloud sync ----------
patch(
  'mount-cloud-sync',
  `    this.flush = () => { if (this.fileHandle && !this.suppressFlush) this.saveToFile(true); };
    window.addEventListener('beforeunload', this.flush);
    window.addEventListener('pagehide', this.flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
    this.keepAlive = setInterval(this.flush, 30000);
    this.recallHandle().then(async h => {
      if (!h) return;
      this.fileHandle = h;
      let p = 'prompt';
      try { p = await h.queryPermission({ mode: 'readwrite' }); } catch (e) {}
      if (p !== 'granted') {
        this.setState({ fileNote: 'Datei ' + h.name + ' gefunden – einmal auf 💾 Speichern klicken zum Freigeben' });
        return;
      }
      try {
        const dd = JSON.parse(await (await h.getFile()).text());
        let localAt = 0;
        try { localAt = (JSON.parse(localStorage.getItem(KEY) || '{}') || {}).savedAt || 0; } catch (e) {}
        const fileAt = dd && dd.savedAt ? Date.parse(dd.savedAt) : 0;
        if (dd && dd.lists && fileAt >= localAt - 2000) {
          this.save({ lists:dd.lists || {}, belege:dd.belege || {}, over:dd.over || {}, extra:dd.extra || {}, extraAreas:dd.extraAreas || [],
            fileNote: 'aus ' + h.name + ' geladen – speichert automatisch' });
        } else {
          this.setState({ fileNote: 'verbunden mit ' + h.name + ' – speichert automatisch' });
        }
      } catch (e) {
        this.setState({ fileNote: 'verbunden mit ' + h.name + ' – speichert automatisch' });
      }
    });`,
  `    this.revs = {}; this.syncedJson = {}; this.lastSeq = 0; this.bootstrapped = false;
    this.bootstrap();
    this.onFocusSync = () => this.pollChanges();
    this.onVisSync = () => { if (document.visibilityState === 'visible') this.pollChanges(); };
    this.onOnlineSync = () => this.syncNow();
    window.addEventListener('focus', this.onFocusSync);
    document.addEventListener('visibilitychange', this.onVisSync);
    window.addEventListener('online', this.onOnlineSync);
    this.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') this.pollChanges(); }, 15000);`
);

// ---------- componentWillUnmount ----------
patch(
  'unmount-cleanup',
  `  componentWillUnmount() {
    clearInterval(this.timer); clearInterval(this.keepAlive);
    if (this.flush) { window.removeEventListener('beforeunload', this.flush); window.removeEventListener('pagehide', this.flush); }
  }`,
  `  componentWillUnmount() {
    clearInterval(this.timer); clearInterval(this.pollTimer);
    clearTimeout(this.syncT); clearTimeout(this.retryT); clearTimeout(this.bootT);
    window.removeEventListener('focus', this.onFocusSync);
    document.removeEventListener('visibilitychange', this.onVisSync);
    window.removeEventListener('online', this.onOnlineSync);
  }`
);

// ---------- persist(): cloud sync instead of file autosave; insert sync engine ----------
patch(
  'persist-and-cloud-engine',
  `    this.autoSave();
  }
  save(next) { this.setState(next, () => this.persist()); }`,
  `    this.queueCloudSync();
  }
  save(next) { this.setState(next, () => this.persist()); }

  // ---- Cloud-Synchronisation: die Worker-API (D1) ist die einzige Datenquelle. ----
  // Jeder Datensatz (Liste/Belege/Überschreibung je PDP, extra, extraAreas) wird
  // einzeln mit optimistischer Revision (baseRev) geschrieben, damit zwei Nutzer
  // an verschiedenen PDPs niemals die Änderungen des anderen überschreiben.
  cloudRecords() {
    const s = this.state, recs = {};
    Object.keys(s.lists || {}).forEach(k => { recs['list:' + k] = s.lists[k]; });
    Object.keys(s.belege || {}).forEach(k => { recs['belege:' + k] = s.belege[k]; });
    Object.keys(s.over || {}).forEach(k => { recs['over:' + k] = s.over[k]; });
    recs['meta:extra'] = s.extra || {};
    recs['meta:extraAreas'] = s.extraAreas || [];
    return recs;
  }
  applyRecords(records) {
    this.suppressCloud = true;
    this.setState(s => {
      const lists = Object.assign({}, s.lists), belege = Object.assign({}, s.belege), over = Object.assign({}, s.over);
      let extra = s.extra, extraAreas = s.extraAreas;
      records.forEach(rec => {
        const id = rec.type + ':' + rec.key;
        this.revs[id] = rec.rev;
        this.syncedJson[id] = JSON.stringify(rec.data);
        if (rec.seq > this.lastSeq) this.lastSeq = rec.seq;
        if (rec.type === 'list') lists[rec.key] = rec.data;
        else if (rec.type === 'belege') belege[rec.key] = rec.data;
        else if (rec.type === 'over') over[rec.key] = rec.data;
        else if (rec.type === 'meta' && rec.key === 'extra') extra = rec.data;
        else if (rec.type === 'meta' && rec.key === 'extraAreas') extraAreas = rec.data;
      });
      return { lists, belege, over, extra, extraAreas };
    }, () => { this.suppressCloud = false; });
  }
  async bootstrap() {
    this.setState({ sync: 'loading', syncMsg: 'Daten werden geladen…' });
    try {
      const r = await fetch('/api/bootstrap', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.json();
      const lists = {}, belege = {}, over = {};
      let extra = {}, extraAreas = [];
      this.revs = {}; this.syncedJson = {}; this.lastSeq = b.seq || 0;
      (b.records || []).forEach(rec => {
        const id = rec.type + ':' + rec.key;
        this.revs[id] = rec.rev;
        this.syncedJson[id] = JSON.stringify(rec.data);
        if (rec.type === 'list') lists[rec.key] = rec.data;
        else if (rec.type === 'belege') belege[rec.key] = rec.data;
        else if (rec.type === 'over') over[rec.key] = rec.data;
        else if (rec.type === 'meta' && rec.key === 'extra') extra = rec.data;
        else if (rec.type === 'meta' && rec.key === 'extraAreas') extraAreas = rec.data;
      });
      this.bootstrapped = true;
      this.suppressCloud = true;
      this.setState({ lists, belege, over, extra, extraAreas, sync: 'ok', syncMsg: '' }, () => { this.suppressCloud = false; });
    } catch (e) {
      this.setState({ sync: 'error', syncMsg: 'Keine Verbindung zum Server – neuer Versuch gleich' });
      clearTimeout(this.bootT);
      this.bootT = setTimeout(() => this.bootstrap(), 8000);
    }
  }
  queueCloudSync() {
    if (this.suppressCloud) return;
    clearTimeout(this.syncT);
    this.syncT = setTimeout(() => this.syncNow(), 800);
  }
  async syncNow() {
    if (!this.bootstrapped) { this.bootstrap(); return; }
    if (this.syncing) { this.syncAgain = true; return; }
    const recs = this.cloudRecords();
    const dirty = Object.keys(recs).filter(id => JSON.stringify(recs[id]) !== this.syncedJson[id]);
    if (!dirty.length) { if (this.state.sync !== 'ok') this.setState({ sync: 'ok', syncMsg: '' }); return; }
    this.syncing = true;
    this.setState({ sync: 'saving', syncMsg: 'Speichert…' });
    let conflictMsg = '', failed = false;
    for (const id of dirty) {
      const type = id.slice(0, id.indexOf(':')), key = id.slice(id.indexOf(':') + 1);
      try {
        const r = await fetch('/api/record/' + encodeURIComponent(type) + '/' + encodeURIComponent(key), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: recs[id], baseRev: this.revs[id] || 0 })
        });
        if (r.status === 200) {
          const rec = await r.json();
          this.revs[id] = rec.rev;
          this.syncedJson[id] = JSON.stringify(recs[id]);
          if (rec.seq > this.lastSeq) this.lastSeq = rec.seq;
        } else if (r.status === 409) {
          const cur = await r.json();
          if (cur && cur.rev) {
            this.applyRecords([cur]);
            conflictMsg = 'Konflikt bei ' + key + ' – neuere Daten eines anderen Nutzers geladen';
          } else { failed = true; }
        } else { failed = true; }
      } catch (e) { failed = true; }
    }
    this.syncing = false;
    if (failed) {
      this.setState({ sync: 'error', syncMsg: 'Nicht gespeichert – Verbindung prüfen' });
      clearTimeout(this.retryT);
      this.retryT = setTimeout(() => this.syncNow(), 10000);
    } else if (conflictMsg) {
      this.setState({ sync: 'ok', syncMsg: conflictMsg });
    } else {
      this.setState({ sync: 'ok', syncMsg: '' });
    }
    if (this.syncAgain) { this.syncAgain = false; this.queueCloudSync(); }
  }
  async pollChanges() {
    if (!this.bootstrapped || this.syncing) return;
    try {
      const r = await fetch('/api/changes?since=' + this.lastSeq, { cache: 'no-store' });
      if (!r.ok) return;
      const b = await r.json();
      const recs = this.cloudRecords();
      const incoming = (b.records || []).filter(rec => {
        const id = rec.type + ':' + rec.key;
        const localDirty = recs[id] !== undefined && JSON.stringify(recs[id]) !== this.syncedJson[id];
        return !localDirty;
      });
      if (incoming.length) this.applyRecords(incoming);
      if (b.seq > this.lastSeq) this.lastSeq = b.seq;
      if (this.state.sync === 'error') this.syncNow();
    } catch (e) {}
  }`
);

// ---------- autoSave(): no more file flush ----------
patch(
  'autosave-cloud',
  `  autoSave() {
    clearTimeout(this.autoT);
    this.autoT = setTimeout(() => { if (this.fileHandle) this.saveToFile(true); }, 1200);
  }`,
  `  autoSave() { this.queueCloudSync(); }`
);

// ---------- PIN gate removed ----------
patch(
  'can-always-true',
  `  can(retry) {
    if (this.state.unlocked) return true;
    this.pending = typeof retry === 'function' ? retry : null;
    this.setState({ askPin: true, pin: '', pinError: false });
    return false;
  }`,
  `  can() { return true; }`
);
patch('pin-scrub-submit', `String(this.state.pin).trim() === '1374'`, `false`);
patch('pin-scrub-keydown', `String(e.target.value).trim() === '1374'`, `false`);

// ---------- lock UI becomes the sync status indicator ----------
patch(
  'lock-bindings',
  `      locked: !this.state.unlocked,
      askPin: this.state.askPin,
      pin: this.state.pin,
      pinError: this.state.pinError,
      lockLabel: this.state.unlocked ? 'Entsperrt' : 'Gesperrt',
      lockIcon: this.state.unlocked ? '🔓' : '🔒',`,
  `      locked: false,
      askPin: false,
      pin: '',
      pinError: false,
      lockLabel: ({ init: 'Cloud', loading: 'Lädt…', saving: 'Speichert…', ok: (this.state.syncMsg || 'Gespeichert'), error: (this.state.syncMsg || 'Synchronisierungsfehler – erneut versuchen') })[this.state.sync] || 'Cloud',
      lockIcon: ({ init: '☁️', loading: '⏳', saving: '⏳', ok: '☁️', error: '⚠️' })[this.state.sync] || '☁️',`
);
patch(
  'lock-style-toggle',
  `      lockStyle: \`display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;user-select:none;border:1px solid \${this.state.unlocked ? '#bcdfcb' : '#e2c9cd'};background:\${this.state.unlocked ? '#f2faf5' : '#fdf5f6'};color:\${this.state.unlocked ? '#14603a' : '#a3253a'}\`,
      toggleLock: () => this.state.unlocked ? this.setState({ unlocked: false }, () => this.saveToFile(true)) : this.setState({ askPin: true, pin: '', pinError: false }),`,
  `      lockStyle: (st => \`display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;user-select:none;border:1px solid \${st === 'error' ? '#e2c9cd' : st === 'ok' ? '#bcdfcb' : '#e0e0da'};background:\${st === 'error' ? '#fdf5f6' : st === 'ok' ? '#f2faf5' : '#fafaf8'};color:\${st === 'error' ? '#a3253a' : st === 'ok' ? '#14603a' : '#77776f'}\`)(this.state.sync),
      toggleLock: () => this.syncNow(),`
);

// ---------- file buttons: backup download / backup import ----------
patch(
  'savefile-backup-download',
  `      saveFile: () => this.saveToFile(false),`,
  `      saveFile: () => { const a = document.createElement('a'); a.href = '/api/backup'; a.download = FILENAME; document.body.appendChild(a); a.click(); a.remove(); },`
);
patch(
  'loadfile-import',
  `      loadFile: () => { if (this.can()) this.connectFile(); },`,
  `      loadFile: () => this.loadFromFile(),`
);
patch(
  'filenote-cloud',
  `      fileNote: this.state.fileNote || (this.fileHandle ? 'mit Datei verbunden – Speichern überschreibt sie direkt' : 'noch nicht in eine Datei gesichert'),`,
  `      fileNote: this.state.fileNote || 'zentrale Cloud-Datenbank – speichert automatisch',`
);
patch(
  'savednote-cloud',
  `      savedNote: 'lokal gespeichert',`,
  `      savedNote: 'Cloud-Datenbank',`
);

// ---------- template texts (German, cloud workflow) ----------
patch(
  'banner-text',
  `Alle Daten liegen in <strong style="font-family:'IBM Plex Mono', monospace">{{ fileName }}</strong> – niemals löschen oder umbenennen. Einmal <strong>💾 Speichern</strong> (Datei im Synology-Ordner wählen) oder <strong>🔗 Datei verbinden</strong> – danach wird genau diese Datei bei jeder Änderung automatisch überschrieben, es entstehen keine Kopien.`,
  `Alle Daten liegen zentral in der Cloud-Datenbank und werden bei jeder Änderung automatisch gespeichert – alle Nutzer sehen denselben Stand. <strong>💾 Backup herunterladen</strong> sichert zusätzlich eine JSON-Kopie ({{ fileName }}).`
);
patch(
  'btn-save-label',
  `title="Alle Daten in die Datei sichern">💾 Speichern</button>`,
  `title="Backup der Cloud-Datenbank als JSON-Datei herunterladen">💾 Backup herunterladen</button>`
);
patch(
  'btn-load-label',
  `title="Bestehende Datei verbinden und laden">🔗 Datei verbinden</button>`,
  `title="JSON-Backup in die Cloud-Datenbank importieren">📂 Backup importieren</button>`
);
patch(
  'lock-title',
  `title="Bearbeitung sperren / entsperren">`,
  `title="Synchronisierungsstatus – klicken speichert sofort">`
);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(`OK: ${applied} Patches angewendet → ${output} (${html.length} Bytes)`);
