// Offline cache. DEPLOY RITUAL: bump VERSION on every deploy — it is what
// makes phones pick up new files. Add any new file to ASSETS.
//
// This app shares its origin (modzer627.github.io) with other PWAs, so the
// cleanup below only ever touches caches with OUR prefix, and ensureAssets()
// re-fills the precache if another app's worker wipes it.
const VERSION = 'v0.1.0';
const PREFIX = 'van-inventory-';
const CACHE = PREFIX + VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/codes.js',
  './js/items.js',
  './js/barcodes.js',
  './js/locations.js',
  './js/txns.js',
  './js/counts.js',
  './js/import-parse.js',
  './js/importer.js',
  './js/analytics.js',
  './js/charts.js',
  './js/export.js',
  './js/backup.js',
  './js/scanner.js',
  './js/scan-session.js',
  './js/ui.js',
  './js/nav.js',
  './js/views/scan.js',
  './js/views/parts.js',
  './js/views/part.js',
  './js/views/shelves.js',
  './js/views/shelf.js',
  './js/views/count.js',
  './js/views/insights.js',
  './js/views/settings.js',
  './js/views/locations.js',
  './js/views/sheets.js',
  './vendor/barcode-detector/ponyfill.js',
  './vendor/zxing/zxing_reader.wasm',
  './vendor/sheetjs/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

let lastCheck = 0;

async function ensureAssets() {
  try {
    const cache = await caches.open(CACHE);
    const have = new Set((await cache.keys()).map(r => r.url));
    const missing = ASSETS.filter(a => !have.has(new URL(a, self.location.href).href));
    if (missing.length) await cache.addAll(missing);
  } catch { /* offline or partial — try again next navigation */ }
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .then(ensureAssets)
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate' && navigator.onLine && Date.now() - lastCheck > 10 * 60 * 1000) {
    lastCheck = Date.now();
    e.waitUntil(ensureAssets());
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(hit =>
      hit ||
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
    )
  );
});
