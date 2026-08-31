// GLOBAL NE3B PRODUKTION – Cloudflare Worker
// Serves the static frontend (public/) and the record API backed by D1.
//
// Concurrency model: record-scoped optimistic locking. Every record carries a
// `rev` that the client must send back as `baseRev`; a mismatch returns 409
// with the current server record so the client can react without data loss.
// Every successful write also gets a globally monotonic `seq` so clients can
// poll GET /api/changes?since=<seq> cheaply.

const VALID_TYPES = new Set(['list', 'belege', 'over', 'meta']);
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const META_KEYS = new Set(['extra', 'extraAreas']);
const MAX_BODY_BYTES = 700_000;
const MAX_ROWS = 3000;
const MAX_BELEGE = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: 'Serverfehler' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dailyBackup(env));
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // Same-origin guard for mutating requests. No CORS headers are ever sent,
  // so cross-origin scripts cannot read responses; this additionally rejects
  // cross-origin write attempts that carry an Origin header.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) {
      return json({ error: 'Ungültiger Ursprung' }, 403);
    }
  }

  if (pathname === '/api/health' && method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS seq FROM records'
    ).first();
    return json({ ok: true, db: 'ok', records: row.n, seq: row.seq });
  }

  if (pathname === '/api/bootstrap' && method === 'GET') {
    const rs = await env.DB.prepare(
      'SELECT type, key, data, rev, seq FROM records'
    ).all();
    const records = rs.results.map(rowToRecord);
    const seq = records.reduce((m, r) => Math.max(m, r.seq), 0);
    return json({ seq, records });
  }

  if (pathname === '/api/changes' && method === 'GET') {
    const since = clampInt(url.searchParams.get('since'), 0);
    const rs = await env.DB.prepare(
      'SELECT type, key, data, rev, seq FROM records WHERE seq > ? ORDER BY seq ASC LIMIT 500'
    ).bind(since).all();
    const records = rs.results.map(rowToRecord);
    const row = await env.DB.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM records'
    ).first();
    return json({ seq: row.seq, records });
  }

  if (pathname === '/api/backup' && method === 'GET') {
    const body = JSON.stringify(await snapshotFromDb(env), null, 1);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="NE3-DATEN-NICHT-LOESCHEN.json"',
        'Cache-Control': 'no-store',
      },
    });
  }

  const recMatch = pathname.match(/^\/api\/record\/([^/]+)\/([^/]+)$/);
  if (recMatch) {
    const type = decodeURIComponent(recMatch[1]);
    const key = decodeURIComponent(recMatch[2]);
    if (!VALID_TYPES.has(type) || !KEY_RE.test(key) || (type === 'meta' && !META_KEYS.has(key))) {
      return json({ error: 'Ungültiger Datensatz' }, 400);
    }
    if (method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT type, key, data, rev, seq FROM records WHERE type = ? AND key = ?'
      ).bind(type, key).first();
      if (!row) return json({ error: 'Nicht gefunden' }, 404);
      return json(rowToRecord(row));
    }
    if (method === 'PUT') {
      return putRecord(request, env, type, key);
    }
    return json({ error: 'Methode nicht erlaubt' }, 405);
  }

  return json({ error: 'Nicht gefunden' }, 404);
}

async function putRecord(request, env, type, key) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Anfrage zu groß' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Ungültiges JSON' }, 400);
  }
  const baseRev = Number.isInteger(body.baseRev) && body.baseRev >= 0 ? body.baseRev : 0;
  const problem = validateData(type, key, body.data);
  if (problem) return json({ error: problem }, 400);

  const dataStr = JSON.stringify(body.data);
  const now = new Date().toISOString();

  if (baseRev === 0) {
    const ins = await env.DB.prepare(
      `INSERT INTO records (type, key, data, rev, seq, updated_at)
       SELECT ?1, ?2, ?3, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records), ?4
       WHERE NOT EXISTS (SELECT 1 FROM records WHERE type = ?1 AND key = ?2)`
    ).bind(type, key, dataStr, now).run();
    if (ins.meta.changes === 1) return currentRecord(env, type, key, 200);
    return currentRecord(env, type, key, 409);
  }

  const upd = await env.DB.prepare(
    `UPDATE records
     SET data = ?3, rev = rev + 1, seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM records), updated_at = ?4
     WHERE type = ?1 AND key = ?2 AND rev = ?5`
  ).bind(type, key, dataStr, now, baseRev).run();
  if (upd.meta.changes === 1) return currentRecord(env, type, key, 200);
  return currentRecord(env, type, key, 409);
}

async function currentRecord(env, type, key, status) {
  const row = await env.DB.prepare(
    'SELECT type, key, data, rev, seq FROM records WHERE type = ? AND key = ?'
  ).bind(type, key).first();
  if (!row) return json({ error: 'Datensatz nicht gefunden' }, status === 200 ? 500 : 404);
  return json(rowToRecord(row), status);
}

function validateData(type, key, data) {
  if (data === undefined) return 'Feld "data" fehlt';
  if (type === 'list') {
    if (!isPlainObject(data) || !Array.isArray(data.rows)) return 'Liste braucht {meta, rows[]}';
    if (data.rows.length > MAX_ROWS) return 'Zu viele Zeilen';
    if (!data.rows.every(isPlainObject)) return 'Ungültige Zeilen';
    if (data.meta !== undefined && !isPlainObject(data.meta)) return 'Ungültiges meta';
    return null;
  }
  if (type === 'belege') {
    if (!Array.isArray(data) || data.length > MAX_BELEGE) return 'Belege müssen eine Liste sein';
    if (!data.every(isPlainObject)) return 'Ungültige Belege';
    return null;
  }
  if (type === 'over') {
    if (!isPlainObject(data)) return 'Überschreibungen müssen ein Objekt sein';
    return null;
  }
  if (type === 'meta') {
    if (key === 'extra' && !isPlainObject(data)) return 'extra muss ein Objekt sein';
    if (key === 'extraAreas' && !Array.isArray(data)) return 'extraAreas muss eine Liste sein';
    return null;
  }
  return 'Unbekannter Typ';
}

async function snapshotFromDb(env) {
  const rs = await env.DB.prepare('SELECT type, key, data FROM records').all();
  const out = {
    app: 'GGB-NE3',
    version: 1,
    savedAt: new Date().toISOString(),
    lists: {},
    belege: {},
    over: {},
    extra: {},
    extraAreas: [],
  };
  for (const row of rs.results) {
    const data = JSON.parse(row.data);
    if (row.type === 'list') out.lists[row.key] = data;
    else if (row.type === 'belege') out.belege[row.key] = data;
    else if (row.type === 'over') out.over[row.key] = data;
    else if (row.type === 'meta' && row.key === 'extra') out.extra = data;
    else if (row.type === 'meta' && row.key === 'extraAreas') out.extraAreas = data;
  }
  return out;
}

async function dailyBackup(env) {
  const snapshot = await snapshotFromDb(env);
  const day = snapshot.savedAt.slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO backups (day, data, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(day) DO UPDATE SET data = ?2, created_at = ?3`
  ).bind(day, JSON.stringify(snapshot), snapshot.savedAt).run();
  await env.DB.prepare(
    `DELETE FROM backups WHERE day NOT IN (SELECT day FROM backups ORDER BY day DESC LIMIT 30)`
  ).run();
}

function rowToRecord(row) {
  return { type: row.type, key: row.key, rev: row.rev, seq: row.seq, data: JSON.parse(row.data) };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
