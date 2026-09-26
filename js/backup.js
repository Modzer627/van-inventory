// JSON backup / restore — the safety net while the data lives only on the phone.
import { dbAll, withTx, reqP, metaGet, metaSet, notifyDataChanged } from './db.js';
import { deliverFile } from './export.js';
import { isoDate } from './ui.js';
import { ensureSeed } from './locations.js';

const APP_TAG = 'VanInventory';
const SCHEMA_VERSION = 1;
const BACKUP_NAG_DAYS = 30;
const DATA_STORES = ['items', 'barcodes', 'locations', 'txns', 'counts'];
const META_KEYS = ['recentJobs', 'lastImport', 'firstTxnAt'];

export async function buildBackupPayload() {
  const [items, barcodes, locations, txns, counts, meta] = await Promise.all([
    dbAll('items'), dbAll('barcodes'), dbAll('locations'), dbAll('txns'), dbAll('counts'), dbAll('meta'),
  ]);
  return {
    app: APP_TAG,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    deviceId: await metaGet('deviceId', null),
    items, barcodes, locations, txns, counts,
    meta: meta.filter(m => META_KEYS.includes(m.key)),
  };
}

export async function exportBackup() {
  const payload = await buildBackupPayload();
  const json = JSON.stringify(payload);
  const result = await deliverFile(`van-inventory-backup-${isoDate()}.json`, json, 'application/json');
  if (result === 'shared' || result === 'downloaded') await metaSet('lastBackupAt', Date.now());
  return result;
}

export async function readBackupFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a valid backup file'); }
  if (data.app !== APP_TAG || !Array.isArray(data.items) || !Array.isArray(data.txns)) {
    throw new Error('Not a Van Inventory backup file');
  }
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new Error('Backup was made by a newer app version — update this app first');
  }
  for (const s of DATA_STORES) if (!Array.isArray(data[s])) data[s] = [];
  return data;
}

/**
 * mode 'replace': wipe everything and load the backup as-is.
 * mode 'merge': per record the newest updatedAt wins (tombstones included); ledger rows are unioned.
 */
export async function restoreBackup(data, mode) {
  const counts = {};
  await withTx(DATA_STORES, 'readwrite', async (t) => {
    if (mode === 'replace') {
      for (const s of DATA_STORES) t.objectStore(s).clear();
      for (const s of DATA_STORES) {
        for (const row of data[s]) t.objectStore(s).put(row);
        counts[s] = data[s].length;
      }
      return;
    }
    for (const s of DATA_STORES) {
      const store = t.objectStore(s);
      const local = new Map((await reqP(store.getAll())).map(r => [r[store.keyPath], r]));
      let n = 0;
      for (const row of data[s]) {
        const mine = local.get(row[store.keyPath]);
        if (s === 'txns') { if (!mine) { store.put(row); n++; } continue; }
        if (!mine || (row.updatedAt || 0) > (mine.updatedAt || 0)) { store.put(row); n++; }
      }
      counts[s] = n;
    }
  });
  const incomingJobs = (data.meta || []).find(m => m.key === 'recentJobs')?.value || [];
  if (incomingJobs.length) {
    const localJobs = await metaGet('recentJobs', []);
    const seen = new Set(localJobs.map(j => j.toLowerCase()));
    await metaSet('recentJobs', [...localJobs, ...incomingJobs.filter(j => !seen.has(j.toLowerCase()))].slice(0, 10));
  }
  const first = (data.meta || []).find(m => m.key === 'firstTxnAt')?.value;
  if (first && !(await metaGet('firstTxnAt', null))) await metaSet('firstTxnAt', first);
  if (mode === 'replace') await metaSet('openCountId', null);
  await ensureSeed();
  notifyDataChanged({ type: 'restore' });
  return counts;
}

export async function backupBannerNeeded(itemCount) {
  if (!itemCount) return false;
  const last = await metaGet('lastBackupAt', null);
  if (!last) return true;
  return Date.now() - last > BACKUP_NAG_DAYS * 24 * 3600 * 1000;
}

export async function daysSinceBackup() {
  const last = await metaGet('lastBackupAt', null);
  if (!last) return null;
  return Math.floor((Date.now() - last) / (24 * 3600 * 1000));
}
