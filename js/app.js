// Boot: database, locations seed, views, tab bar, service worker, install
// prompt, persistent storage, console/dev hooks.
import { initDB, metaGet, metaSet, dbClear, dbAll, uuid, setDeviceId, STORES } from './db.js';
import { setSoundEnabled, setHapticsEnabled, unlockAudio, toast } from './ui.js';
import * as nav from './nav.js';
import { ensureSeed } from './locations.js';
import scanView from './views/scan.js';
import partsView from './views/parts.js';
import partView from './views/part.js';
import shelvesView from './views/shelves.js';
import shelfView from './views/shelf.js';
import { countView, countReviewView, countDetailView } from './views/count.js';
import insightsView from './views/insights.js';
import settingsView from './views/settings.js';
import locationsView from './views/locations.js';

const APP_VERSION = '0.1.0';
window.__appVersion = APP_VERSION;
window.__updateReady = false;
window.__installPrompt = null;

async function boot() {
  try {
    await initDB();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:2rem;font-family:system-ui">
      <h2>Storage unavailable</h2>
      <p>Van Inventory could not open its local database (${e && e.name || 'error'}).
      If you are in a private/incognito tab, open the app normally instead.</p></div>`;
    return;
  }

  // Ask the browser to protect our data from automatic cleanup (granted to installed apps).
  try {
    const persisted = await navigator.storage?.persist?.();
    await metaSet('storagePersisted', !!persisted);
  } catch { /* best-effort */ }

  let dev = await metaGet('deviceId', null);
  if (!dev) { dev = uuid(); await metaSet('deviceId', dev); }
  setDeviceId(dev);

  setSoundEnabled(await metaGet('soundOn', true));
  setHapticsEnabled(await metaGet('hapticsOn', true));
  await ensureSeed();

  nav.register('scan', scanView);
  nav.register('parts', partsView);
  nav.register('part', partView);
  nav.register('shelves', shelvesView);
  nav.register('shelf', shelfView);
  nav.register('count', countView);
  nav.register('count-review', countReviewView);
  nav.register('count-detail', countDetailView);
  nav.register('insights', insightsView);
  nav.register('settings', settingsView);
  nav.register('locations', locationsView);

  wireTabBar();
  nav.installBackHandler();

  const startTab = await metaGet('startTab', 'scan');
  await nav.showTab(nav.TABS.includes(startTab) ? startTab : 'scan');

  document.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__installPrompt = e;
  });

  registerSW();
}

function wireTabBar() {
  const bar = document.getElementById('tabbar');
  bar.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    if (nav.currentScreen() === tab && nav.depth() === 1) { nav.refresh(); return; }
    nav.showTab(tab);
  }));
  window.addEventListener('nav:changed', (e) => {
    const name = e.detail.name;
    const tab = TAB_OF[name] || name;
    bar.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  });
}

const TAB_OF = {
  part: 'parts', shelf: 'shelves', 'count-review': 'count', 'count-detail': 'count',
  settings: 'insights', locations: 'shelves',
};

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Skip SW on plain localhost dev so edits show up without cache-version bumps.
  const params = new URLSearchParams(location.search);
  if (params.get('nosw') === '1') return;

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          window.__updateReady = true;
          toast('Update ready', { actionLabel: 'Reload', action: () => window.__applyUpdate && window.__applyUpdate(), duration: 8000 });
        }
      });
    });
    window.__applyUpdate = () => {
      const waiting = reg.waiting;
      if (waiting) waiting.postMessage('skipWaiting');
      else location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }).catch(() => { /* offline-first is a bonus; the app still runs */ });
}

/* ---- dev / console helpers ---- */

/** Simulate a scan without a camera: __scan('843122104825') */
window.__scan = async (code, format = 'code_128') => {
  if (nav.currentScreen() !== 'scan') await nav.showTab('scan');
  return scanView.simulate(String(code), format);
};

/** Import a spreadsheet by URL (served from this origin), skipping the preview. */
window.__importFile = async (url = 'local/van.xlsx', { updateExisting = false } = {}) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const blob = await res.blob();
  const file = new File([blob], url.split('/').pop(), { type: blob.type });
  const { readGrid, analyzeGrid, applyImport } = await import('./importer.js');
  const grid = await readGrid(file);
  const analysis = await analyzeGrid(grid, { fileName: file.name });
  const result = await applyImport(analysis, { updateExisting, fileName: file.name });
  nav.refresh();
  return { ...result, report: analysis.report, newCount: analysis.newCount, existingCount: analysis.existingCount, conflicts: analysis.conflicts };
};

window.__stats = async () => {
  const out = {};
  for (const s of STORES) out[s] = (await dbAll(s)).length;
  const items = (await dbAll('items')).filter(i => !i.deletedAt);
  out.liveItems = items.length;
  out.liveCodes = (await dbAll('barcodes')).filter(b => !b.deletedAt).length;
  out.byLocation = {};
  for (const i of items) { const k = i.locationId || 'UNASSIGNED'; out.byLocation[k] = (out.byLocation[k] || 0) + 1; }
  out.ft = items.filter(i => i.unit === 'ft').length;
  out.verify = items.filter(i => i.flags && i.flags.verify).length;
  return out;
};

window.__resetAll = async () => {
  await dbClear(...STORES);
  await ensureSeed();
  setDeviceId(uuid());
  await metaSet('deviceId', uuid());
  await nav.showTab('parts');
  return 'wiped';
};

boot().catch(e => {
  console.error('Boot failed', e);
  toast('App failed to start: ' + (e.message || e), { error: true, duration: 8000 });
});
