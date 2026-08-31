-- GLOBAL NE3B PRODUKTION – initial schema.
-- One row per record. Record types:
--   list   / <PDP>        – Produktionsliste {meta:{mfg,datum}, rows:[...]}
--   belege / <PDP>        – Beleg-Zeilen [{nr,has,gf,splice,otdr,huep}, ...]
--   over   / <PDP>        – manuelle Überschreibungen {has,gf,splice,otdr,huep}
--   meta   / extra        – zusätzliche PDPs pro Gebiet {AREA:[PDP,...]}
--   meta   / extraAreas   – zusätzliche Gebiete [{area,polygon,pdps}]
-- rev: optimistic-concurrency revision, incremented on every write.
-- seq: global monotonic change sequence for cheap "what changed since N" polling.
CREATE TABLE IF NOT EXISTS records (
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (type, key)
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(seq);

-- Daily JSON snapshots written by the scheduled handler (retention: newest 30).
CREATE TABLE IF NOT EXISTS backups (
  day TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
