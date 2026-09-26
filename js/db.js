// IndexedDB layer. Stores: items, barcodes (keyed by normalized code),
// locations, txns (append-only movement ledger), counts (stocktake sessions +
// quarterly snapshots), meta (key/value settings).
//
// Same origin as the user's other PWAs — the database name must stay unique.
const DB_NAME = 'van-inventory';
const DB_VERSION = 1;

let _db = null;
let _deviceId = null;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** Fired after any inventory mutation so open screens can refresh. */
export function notifyDataChanged(detail = {}) {
  try { window.dispatchEvent(new CustomEvent('van:changed', { detail })); } catch { /* non-browser context */ }
}

export function setDeviceId(id) { _deviceId = id; }
export function deviceId() { return _deviceId; }

function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('locationId', 'locationId');
        s.createIndex('nameKey', 'nameKey');
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('barcodes')) {
        // keyPath = normalized code → one part per code, enforced by the store itself.
        const s = db.createObjectStore('barcodes', { keyPath: 'norm' });
        s.createIndex('itemId', 'itemId');
      }
      if (!db.objectStoreNames.contains('locations')) {
        const s = db.createObjectStore('locations', { keyPath: 'id' });
        s.createIndex('parentId', 'parentId');
        s.createIndex('sort', 'sort');
      }
      if (!db.objectStoreNames.contains('txns')) {
        const s = db.createObjectStore('txns', { keyPath: 'id' });
        s.createIndex('itemId', 'itemId');
        s.createIndex('ts', 'ts');
        s.createIndex('type', 'type');
        s.createIndex('countId', 'countId');
      }
      if (!db.objectStoreNames.contains('counts')) {
        const s = db.createObjectStore('counts', { keyPath: 'id' });
        s.createIndex('committedAt', 'committedAt');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
}

export async function initDB() {
  if (_db) return _db;
  try {
    _db = await openOnce();
  } catch {
    await new Promise(r => setTimeout(r, 300)); // first-open flake seen on mobile Safari
    _db = await openOnce();
  }
  _db.onversionchange = () => { _db.close(); _db = null; };
  return _db;
}

function db() {
  if (!_db) throw new Error('DB not initialised');
  return _db;
}

export const STORES = ['items', 'barcodes', 'locations', 'txns', 'counts', 'meta'];

export function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    // On a failed request the bubbled event carries the real error (e.g.
    // ConstraintError) on the request; transaction.error may still be null here.
    t.onerror = (e) => reject((e.target && e.target.error) || t.error || new Error('Transaction error'));
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

/**
 * Run `fn(tx)` inside one transaction and resolve with its return value once
 * the transaction commits. Only await IndexedDB requests (via reqP) inside fn —
 * awaiting anything else lets the transaction auto-commit underneath you.
 * Throwing inside fn aborts the transaction and rejects with that error.
 */
export function withTx(storeNames, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try { t = db().transaction(storeNames, mode); } catch (e) { reject(e); return; }
    let result;
    let failure = null;
    t.oncomplete = () => resolve(result);
    t.onerror = (e) => { if (!failure) failure = (e.target && e.target.error) || t.error; };
    t.onabort = () => reject(failure || t.error || new Error('Transaction aborted'));
    Promise.resolve()
      .then(() => fn(t))
      .then(v => { result = v; })
      .catch(err => {
        failure = err;
        try { t.abort(); } catch { /* already finished */ }
      });
  });
}

export function dbGet(store, key) {
  return reqP(db().transaction(store).objectStore(store).get(key));
}
export function dbAll(store) {
  return reqP(db().transaction(store).objectStore(store).getAll());
}
export function dbAllByIndex(store, index, query) {
  return reqP(db().transaction(store).objectStore(store).index(index).getAll(query));
}
export function dbGetByIndex(store, index, query) {
  return reqP(db().transaction(store).objectStore(store).index(index).get(query));
}
export async function dbPut(store, val) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).put(val);
  await txDone(t);
  return val;
}
export async function dbAdd(store, val) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).add(val);
  await txDone(t);
  return val;
}
export async function dbDel(store, key) {
  const t = db().transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  await txDone(t);
}
export async function dbClear(...stores) {
  const t = db().transaction(stores, 'readwrite');
  for (const s of stores) t.objectStore(s).clear();
  await txDone(t);
}
export async function dbCount(store) {
  return reqP(db().transaction(store).objectStore(store).count());
}

export async function metaGet(key, def = null) {
  const row = await dbGet('meta', key);
  return row === undefined || row === null ? def : row.value;
}
export async function metaSet(key, value) {
  await dbPut('meta', { key, value });
}

export function newTx(stores, mode = 'readonly') {
  return db().transaction(stores, mode);
}

/**
 * Apply a stock movement: updates the part and writes the ledger row in ONE
 * transaction so the two can never drift apart.
 *
 *   delta     signed change (or pass `to` for an absolute quantity)
 *   type      'in' | 'out' | 'set' | 'count' | 'move' | 'import'
 *   toLoc     for type 'move': the destination locationId (null = unassigned)
 *   reverses  id of the txn this one undoes; that txn is marked voided
 * Resolves { item, txn }.
 */
export function applyStockChange({
  itemId, delta = null, to = null, type, note = null, jobRef = null,
  source = 'manual', countId = null, toLoc, reverses = null, ts = null,
}) {
  return new Promise((resolve, reject) => {
    const t = db().transaction(['items', 'txns'], 'readwrite');
    const items = t.objectStore('items');
    const txns = t.objectStore('txns');
    let out = null;
    const fail = (msg) => { try { t.abort(); } catch { /* noop */ } reject(new Error(msg)); };

    const getReq = items.get(itemId);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (!item || item.deletedAt) { fail('Part not found'); return; }
      const now = ts || Date.now();
      const before = round3(item.qty || 0);
      let d = to !== null && to !== undefined ? round3(Number(to) - before) : round3(delta);
      if (type === 'move') d = 0;
      const after = round3(before + d);
      let fromLoc = null;
      if (type === 'move') {
        fromLoc = item.locationId ?? null;
        item.locationId = toLoc ?? null;
      } else {
        item.qty = after;
      }
      if (type !== 'count') item.lastMovedAt = now;
      if (type === 'count') item.lastCountedAt = now;
      item.updatedAt = now;
      items.put(item);
      const txn = {
        id: uuid(), ts: now, itemId,
        label: [item.brand, item.model].filter(Boolean).join(' '),
        unit: item.unit || 'ea',
        type, delta: d, qtyAfter: after,
        locationId: item.locationId ?? null,
        fromLoc, toLoc: type === 'move' ? (toLoc ?? null) : null,
        note: note || null, jobRef: jobRef || null,
        source, countId: countId || null,
        reverses: reverses || null, voided: 0,
        deviceId: _deviceId,
      };
      txns.add(txn);
      if (reverses) {
        const rq = txns.get(reverses);
        rq.onsuccess = () => {
          const orig = rq.result;
          if (orig) { orig.voided = 1; orig.voidedBy = txn.id; txns.put(orig); }
        };
      }
      out = { item, txn };
    };
    t.oncomplete = () => { notifyDataChanged({ itemId, type }); resolve(out); };
    t.onerror = (e) => reject((e.target && e.target.error) || t.error || new Error('Transaction error'));
    t.onabort = () => { if (!out) reject(t.error || new Error('Change not saved')); };
  });
}
