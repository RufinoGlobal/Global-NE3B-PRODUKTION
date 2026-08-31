// Minimal build gate: validates that the Worker parses, the frontend exists and
// still contains the cloud-sync engine, and that no obvious secret material is
// present in tracked source. Fails the deploy on any problem.
import fs from 'node:fs';

let fails = 0;
const fail = (m) => { fails++; console.error('BUILD-FEHLER: ' + m); };

// Worker must be importable (syntax check).
try {
  new Function(fs.readFileSync('src/worker.js', 'utf8').replace(/^export default/m, 'const _d ='));
} catch (e) {
  fail('src/worker.js parst nicht: ' + e.message);
}

// Frontend must exist and contain the cloud engine + robots meta, but no PIN.
const idx = fs.existsSync('public/index.html') ? fs.readFileSync('public/index.html', 'utf8') : '';
if (!idx) fail('public/index.html fehlt');
if (idx && !idx.includes('/api/bootstrap')) fail('Frontend ohne Cloud-Bootstrap');
if (idx && !idx.includes('noindex,nofollow')) fail('robots-Meta fehlt');
if (idx && idx.includes("'1374'")) fail('PIN-Code noch im Frontend');

if (fails) process.exit(1);
console.log('Build-Prüfung OK');
