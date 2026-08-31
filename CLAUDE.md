# GLOBAL NE3B PRODUKTION — Engineering-Verfassung

## Projektzweck

GLOBAL NE3B PRODUKTION verfolgt NE3-Produktion und Zahlungsinformationen
(Payment Checklist) für Glasfaserbau-Projekte: PDP-Produktionslisten,
Hausanschlüsse (HAS), GF Kabel, Spleiß, OTDR, HÜP, Belegnummern, Status,
Summen, Excel-Export und Druck. Die Oberfläche ist Deutsch und bleibt Deutsch.

## Kritische Produktionsdaten-Regel

**Niemals gültige NE3-Produktionsdaten verlieren oder überschreiben.**

- Die Wahrheit liegt in der Cloudflare-D1-Datenbank `global-ne3b-production`.
- `NE3-DATEN-NICHT-LOESCHEN.json` ist das ursprüngliche Import-/Backup-Artefakt
  (bewusst NICHT im Git — siehe `.gitignore`). Niemals löschen oder überschreiben.
- Deployment und Daten sind getrennt: `wrangler deploy` fasst die Datenbank
  nie an. Keine destruktiven Migrationen, kein `DROP TABLE`, kein Neuanlegen
  der D1-Datenbank.
- Jede Schreiboperation ist datensatzbezogen (ein PDP = ein Datensatz) mit
  optimistischer Revision (`baseRev`). Konflikt ⇒ HTTP 409 mit Serverstand,
  niemals stilles Überschreiben.

## Architektur

```
Browser (public/index.html – selbständige React/dc-runtime-App)
   │ HTTPS, same-origin /api/*
   ▼
Cloudflare Worker  global-ne3b-produktion   (src/worker.js)
   │  statische Assets (public/) + JSON-API
   ▼
Cloudflare D1  global-ne3b-production       (Tabellen: records, backups)

GitHub main → Cloudflare Workers Builds → Produktion
```

- Kein Origin-Server, kein Tunnel, kein PC nötig — bewusst anders als die
  GLOBAL BILDER APP.
- Datensatz-Typen in `records`: `list/<PDP>`, `belege/<PDP>`, `over/<PDP>`,
  `meta/extra`, `meta/extraAreas`. Globale `seq`-Spalte für Änderungs-Polling.
- Frontend-Sync: Bootstrap beim Laden, debounced Schreiben pro geändertem
  Datensatz, Polling alle 15 s bei sichtbarem Tab + bei Fokus/Online-Events.

## Frontend-Quellcode

`public/index.html` ist die maßgebliche, produktive App (aus einem
Claude-Design-Export entstanden). Die Anwendungslogik lebt im
`<script type="text/x-dc">`-Block am Dateiende (Klasse `Component extends
DCLogic`), das UI-Template im `<x-dc>`-Block im Body. React/dc-runtime davor
sind gebündelte Bibliotheken — nicht anfassen. `scripts/patch-frontend.mjs`
dokumentiert, wie die Datei ursprünglich aus dem Export erzeugt wurde;
Weiterentwicklung passiert direkt in `public/index.html`.

## Lokale Entwicklung

```
npm install
npx wrangler d1 migrations apply global-ne3b-production --local
npm run dev          # wrangler dev → http://localhost:8787
npm test             # startet selbst ein wrangler dev auf Port 8917
npm run build        # Build-/Konsistenz-Prüfung (scripts/check-build.mjs)
```

## Produktions-Deployment

```
npm run deploy       # Prüfung + wrangler deploy
```

Push auf `main` deployt zusätzlich automatisch über Cloudflare Workers Builds.
Nach jedem Deployment die echte Produktions-URL testen (`/` und `/api/health`)
— niemals Erfolg melden ohne diese Prüfung.

## Datenbank

- Schema/Migrationen: `migrations/*.sql`, angewendet mit
  `npx wrangler d1 migrations apply global-ne3b-production --remote`.
- Migrationen sind inkrementell und dürfen vorhandene Daten nie zerstören.
- Einmaliger Datenimport: `node scripts/generate-import-sql.mjs` erzeugt
  idempotentes SQL (`WHERE NOT EXISTS` — überschreibt nie vorhandene Zeilen).
- Verifikation: `node scripts/verify-migration.mjs <url>` vergleicht jeden
  Datensatz der Quelle mit `/api/bootstrap`.

## Backup

- `GET /api/backup` liefert jederzeit den kompletten D1-Stand im
  GGB-NE3-JSON-Format (Button „💾 Backup herunterladen" in der App).
- Cron (täglich 02:30 UTC) schreibt einen Snapshot in die D1-Tabelle
  `backups`; Aufbewahrung: neueste 30 Tage. R2 ist auf diesem Account nicht
  aktiviert, daher bewusst D1-intern.

## Keine Authentifizierung

**Owner-Anforderung: direkter URL-Zugriff, kein Passwort/Login.**

Kein PIN, kein Login, kein Cloudflare Access. Eine zukünftige Claude-Session
darf das NICHT „reparieren", solange der Eigentümer die Anforderung nicht
ausdrücklich ändert. Schutzmaßnahmen ohne Login: same-origin-API, keine
CORS-Freigaben, serverseitige Validierung, Größenlimits, `noindex,nofollow`
+ `robots.txt`.

## UI-Erhaltung

Der bestehende Geschäftsworkflow und die deutsche Terminologie sind maßgeblich:
NE3 Produktionsliste, Payment Checklist, PDP-Auswahl, Polygone/Gebiete,
Belegnummern, Status-Zyklus (neu → eingereicht → offen → storno), Summen,
Excel-Export, Druck, Undo/Redo, Farben. Keine Umgestaltung ohne Auftrag.

## Test-Anforderung

Jede inhaltliche Backend- oder Persistenz-Änderung braucht Tests
(`test/api.test.mjs`, `npm test`). Tests laufen ausschließlich gegen die
lokale D1 — niemals gegen Produktion.

## Git-Regeln

- Keine Secrets, Tokens, `.dev.vars`, Produktions-Dumps oder Backups
  committen (`.gitignore` beachten).
- `NE3-DATEN-NICHT-LOESCHEN.json` und `NE3-Manager-preview.html` bleiben
  lokal (gitignored).
- Kein Force-Push auf `main`, keine History-Rewrites.
- Produktions-Stand ist `main`.

## Agent-Workflow

Genau drei Projekt-Agenten (`.claude/agents/`):

```
Lead Developer  ──implementiert──▶  UI/UX Designer (prüft bei UI-Änderungen)
      │
      ▼
Tester / Bug Hunter  ──▶  PASS / FAIL
      │ (bei Defekt)
      ▼
Lead Developer behebt ──▶ Tester testet gezielt nach (einmal)
```

- Nur der Lead Developer ändert normalerweise Produktionscode.
- Tester und UI/UX Designer arbeiten primär lesend/prüfend.
- Keine Agent-Kaskaden, keine Endlos-Reviews, ein fokussierter Retest genügt.
