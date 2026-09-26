// Barcode records: many codes per part, keyed by the normalized code.
import { dbGet, dbAll, dbAllByIndex, dbPut, withTx, reqP, notifyDataChanged } from './db.js';
import { classifyCode, kindRank } from './codes.js';
import { ConflictError, makeCodeRec } from './items.js';

/**
 * Look a scanned/typed code up. Returns { cls, rec, item }:
 *   rec  — the live barcode record or null
 *   item — the live part or null (unknown code)
 */
export async function findByCode(raw, format = null) {
  const cls = classifyCode(raw, format);
  if (!cls) return { cls: null, rec: null, item: null };
  const rec = await dbGet('barcodes', cls.norm);
  if (!rec || rec.deletedAt) return { cls, rec: null, item: null };
  const item = await dbGet('items', rec.itemId);
  if (!item || item.deletedAt) return { cls, rec, item: null };
  return { cls, rec, item };
}

/**
 * Remember the exact string a scanner produced for a known code, and upgrade
 * the display code when a scan recovers a leading zero Excel had dropped.
 * Fire-and-forget; never throws.
 */
export async function noteVariant(rec, cls) {
  try {
    let changed = false;
    const raw = cls.raw;
    if (raw && raw !== rec.code && !(rec.variants || []).includes(raw)) {
      rec.variants = [...(rec.variants || []), raw].slice(-6);
      changed = true;
    }
    if (/^\d+$/.test(rec.code) && /^\d+$/.test(cls.code) && cls.code.length > rec.code.length &&
        cls.code.replace(/^0+/, '') === rec.code.replace(/^0+/, '')) {
      rec.code = cls.code;
      if (cls.kind !== 'mfr') rec.kind = cls.kind;
      if (rec.flags) delete rec.flags.fixedLeadingZero;
      changed = true;
    }
    if (changed) { rec.updatedAt = Date.now(); await dbPut('barcodes', rec); }
  } catch { /* cosmetic */ }
}

/** Link a code to a part. Throws ConflictError when a different live part owns it. */
export async function linkCode(itemId, raw, format = null) {
  const cls = classifyCode(raw, format);
  if (!cls) throw new Error('Enter or scan a code first');
  const rec = await withTx(['barcodes'], 'readwrite', async (t) => {
    const bc = t.objectStore('barcodes');
    const existing = await reqP(bc.get(cls.norm));
    if (existing && !existing.deletedAt && existing.itemId !== itemId) throw new ConflictError(existing);
    const next = makeCodeRec(cls, itemId, existing);
    bc.put(next);
    return next;
  });
  notifyDataChanged({ itemId, type: 'code' });
  return rec;
}

/** Move a code from whichever part owns it to `itemId`. */
export async function relinkCode(norm, itemId) {
  const rec = await dbGet('barcodes', norm);
  if (!rec) throw new Error('Code not found');
  const now = Date.now();
  rec.itemId = itemId; rec.deletedAt = null; rec.updatedAt = now; rec.addedAt = now;
  await dbPut('barcodes', rec);
  notifyDataChanged({ itemId, type: 'code' });
  return rec;
}

export async function unlinkCode(norm) {
  const rec = await dbGet('barcodes', norm);
  if (!rec) return;
  rec.deletedAt = Date.now(); rec.updatedAt = rec.deletedAt;
  await dbPut('barcodes', rec);
  notifyDataChanged({ itemId: rec.itemId, type: 'code' });
}

export function sortCodes(recs) {
  return recs.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.addedAt || 0) - (b.addedAt || 0));
}

export async function codesOf(itemId) {
  const recs = await dbAllByIndex('barcodes', 'itemId', itemId);
  return sortCodes(recs.filter(r => !r.deletedAt));
}

/** Map itemId → sorted live code records (one pass over the store). */
export async function codesByItem() {
  const all = await dbAll('barcodes');
  const map = new Map();
  for (const r of all) {
    if (r.deletedAt) continue;
    if (!map.has(r.itemId)) map.set(r.itemId, []);
    map.get(r.itemId).push(r);
  }
  for (const list of map.values()) sortCodes(list);
  return map;
}

export const primaryCode = (recs) => (recs && recs[0] ? recs[0].code : '');
export const otherCodes = (recs) => (recs || []).slice(1).map(r => r.code);
