// Parts (items): normalization, atomic create with codes, edit, soft delete, search.
import { uuid, round3, dbGet, dbAll, dbPut, withTx, reqP, notifyDataChanged, deviceId } from './db.js';
import { classifyCode } from './codes.js';

export class ConflictError extends Error {
  constructor(rec, message) {
    super(message || 'That code is already linked to another part');
    this.name = 'ConflictError';
    this.rec = rec;
  }
}

export const displayName = (i) => [i.brand, i.model].filter(Boolean).join(' ') || '(unnamed part)';
export const nameKeyOf = (brand, model) =>
  `${String(brand || '').trim().toLowerCase()}|${String(model || '').trim().toLowerCase()}`;

const cleanStr = (v) => String(v ?? '').trim();
function posNumOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizePart(data) {
  const brand = cleanStr(data.brand).replace(/\s+/g, ' ');
  const model = cleanStr(data.model).replace(/\s+/g, ' ');
  const cost = posNumOrNull(data.cost);
  return {
    brand,
    model,
    nameKey: nameKeyOf(brand, model),
    type: cleanStr(data.type).toUpperCase(),
    unit: cleanStr(data.unit).toLowerCase() || 'ea',
    min: posNumOrNull(data.min),
    cost: cost === null ? null : Math.round(cost * 100) / 100,
    locationId: data.locationId || null,
    notes: cleanStr(data.notes),
    extId: cleanStr(data.extId) || null,
    flags: { ...(data.flags || {}) },
  };
}

export function makeCodeRec(cls, itemId, existing = null) {
  const now = Date.now();
  const variants = new Set(existing && existing.itemId === itemId ? (existing.variants || []) : []);
  if (cls.raw && cls.raw !== cls.code) variants.add(cls.raw);
  return {
    norm: cls.norm,
    code: cls.code,
    variants: [...variants],
    itemId,
    kind: cls.kind,
    format: cls.format || null,
    flags: Object.keys(cls.flags || {}).length ? { ...cls.flags } : undefined,
    addedAt: existing && existing.itemId === itemId ? existing.addedAt : now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function ledgerRow(item, { type, delta, qtyAfter, note = null, source = 'manual', jobRef = null, countId = null, fromLoc = null, toLoc = null, ts = null }) {
  return {
    id: uuid(), ts: ts || Date.now(), itemId: item.id,
    label: displayName(item), unit: item.unit || 'ea',
    type, delta: round3(delta), qtyAfter: round3(qtyAfter),
    locationId: item.locationId ?? null, fromLoc, toLoc,
    note, jobRef, source, countId, reverses: null, voided: 0, deviceId: deviceId(),
  };
}

/**
 * Create a part with its codes and initial stock in ONE transaction.
 * data.codes: array of raw strings or {code, format}.
 * Rejects with ConflictError when a code already belongs to a live part.
 */
export async function createPart(data) {
  const now = Date.now();
  const base = normalizePart(data);
  if (!base.model) throw new Error('Model / part number is required');
  const qty = round3(Number(String(data.qty ?? 0).replace(',', '.')) || 0);
  const item = {
    id: uuid(), ...base, qty,
    createdAt: now, updatedAt: now,
    lastMovedAt: qty ? now : null, lastCountedAt: null, deletedAt: null,
  };
  const seen = new Set();
  const codes = [];
  for (const c of data.codes || []) {
    const cls = typeof c === 'string' ? classifyCode(c) : classifyCode(c.code, c.format);
    if (cls && !seen.has(cls.norm)) { seen.add(cls.norm); codes.push(cls); }
  }
  const source = data.source || 'manual';
  const created = await withTx(['items', 'barcodes', 'txns'], 'readwrite', async (t) => {
    const bc = t.objectStore('barcodes');
    for (const cls of codes) {
      const existing = await reqP(bc.get(cls.norm));
      if (existing && !existing.deletedAt) throw new ConflictError(existing);
      bc.put(makeCodeRec(cls, item.id, existing));
    }
    t.objectStore('items').add(item);
    if (qty !== 0) {
      t.objectStore('txns').add(ledgerRow(item, {
        type: source === 'import' ? 'import' : 'in', delta: qty, qtyAfter: qty,
        note: data.note || (source === 'import' ? 'Imported' : 'Initial stock'), source, ts: now,
      }));
    }
    return item;
  });
  notifyDataChanged({ itemId: item.id, type: 'create' });
  return created;
}

/** Edit descriptive fields. Quantity and location change through the ledger, not here. */
export async function updatePart(id, patch) {
  const existing = await dbGet('items', id);
  if (!existing) throw new Error('Part not found');
  const merged = normalizePart({ ...existing, ...patch });
  if (!merged.model) throw new Error('Model / part number is required');
  if (!('locationId' in patch)) merged.locationId = existing.locationId ?? null;
  const item = { ...existing, ...merged, updatedAt: Date.now() };
  await dbPut('items', item);
  notifyDataChanged({ itemId: id, type: 'edit' });
  return item;
}

export async function deletePart(id) {
  await withTx(['items', 'barcodes'], 'readwrite', async (t) => {
    const items = t.objectStore('items');
    const item = await reqP(items.get(id));
    if (!item) throw new Error('Part not found');
    const now = Date.now();
    item.deletedAt = now;
    item.updatedAt = now;
    items.put(item);
    const codes = await reqP(t.objectStore('barcodes').index('itemId').getAll(id));
    for (const c of codes) {
      if (c.deletedAt) continue;
      c.deletedAt = now; c.updatedAt = now;
      t.objectStore('barcodes').put(c);
    }
  });
  notifyDataChanged({ itemId: id, type: 'delete' });
}

export async function restorePart(id) {
  await withTx(['items', 'barcodes'], 'readwrite', async (t) => {
    const items = t.objectStore('items');
    const item = await reqP(items.get(id));
    if (!item) throw new Error('Part not found');
    const now = Date.now();
    item.deletedAt = null;
    item.updatedAt = now;
    items.put(item);
    const codes = await reqP(t.objectStore('barcodes').index('itemId').getAll(id));
    for (const c of codes) {
      if (!c.deletedAt || c.itemId !== id) continue; // a newer live owner keeps the code
      c.deletedAt = null; c.updatedAt = now;
      t.objectStore('barcodes').put(c);
    }
  });
  notifyDataChanged({ itemId: id, type: 'restore' });
}

export const getPart = (id) => dbGet('items', id);

export function partCompare(a, b) {
  return (a.brand || '').localeCompare(b.brand || '', undefined, { sensitivity: 'base' }) ||
    (a.model || '').localeCompare(b.model || '', undefined, { sensitivity: 'base', numeric: true });
}

export async function allParts({ includeDeleted = false } = {}) {
  const items = await dbAll('items');
  const live = includeDeleted ? items : items.filter(i => !i.deletedAt);
  live.sort(partCompare);
  return live;
}

export async function deletedParts() {
  const items = await dbAll('items');
  return items.filter(i => i.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
}

export const isLow = (item) => item.min > 0 && item.qty <= item.min;

/** Multi-token AND search over brand, model, type, notes and codes. */
export function searchParts(items, q, codesByItem = null) {
  const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter(it => {
    const hay = [it.brand, it.model, it.type, it.notes].map(v => String(v || '').toLowerCase());
    if (codesByItem) for (const c of codesByItem.get(it.id) || []) { hay.push(c.code.toLowerCase()); for (const v of c.variants || []) hay.push(String(v).toLowerCase()); }
    const s = hay.join(' ');
    return tokens.every(tok => s.includes(tok));
  });
}

export function distinctValues(items, field) {
  return [...new Set(items.map(i => i[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function unitLabel(unit, n = 2) {
  if (!unit || unit === 'ea') return Math.abs(n) === 1 ? 'pc' : 'pcs';
  return unit;
}
