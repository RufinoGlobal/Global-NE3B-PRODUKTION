# GLOBAL NE3B PRODUKTION

Produktions- und Payment-Tracking für NE3-Glasfaserbau (PDP-Produktionslisten,
Payment Checklist, Belege, Excel-Export, Druck).

- **Architektur:** Browser → Cloudflare Worker (`src/worker.js`, statische
  Assets aus `public/`) → Cloudflare D1 (`global-ne3b-production`).
  Eine Anwendung, ein gemeinsamer Datenbestand, viele Nutzer.
- **Kein Login:** direkter URL-Zugriff ist eine bewusste Owner-Anforderung.
- **Details, Regeln und Workflows:** siehe [CLAUDE.md](CLAUDE.md).

## Schnellstart

```
npm install
npx wrangler d1 migrations apply global-ne3b-production --local
npm run dev        # http://localhost:8787
npm test
npm run deploy     # Produktion (nach Build-Prüfung)
```
