// Van locations: shelves 1–6 left, 7–9 right, floor under 3, drawers under 9,
// the Return pile. Seeded once; the user can rename, reorder, add and merge.
import { uuid, dbAll, dbGet, dbPut, withTx, reqP, applyStockChange, notifyDataChanged, metaSet } from './db.js';

export const RET_ID = 'RET';
export const UNASSIGNED_KEY = 'UNASSIGNED';

export const SEED = [
  { id: 'S1', code: '1', name: 'Shelf 1', side: 'left', kind: 'shelf', parentId: null, sort: 10 },
  { id: 'S2', code: '2', name: 'Shelf 2', side: 'left', kind: 'shelf', parentId: null, sort: 20 },
  { id: 'S3', code: '3', name: 'Shelf 3', side: 'left', kind: 'shelf', parentId: null, sort: 30, tag: 'bottom' },
  { id: 'F3', code: '3F', name: 'Floor under 3', side: 'left', kind: 'floor', parentId: 'S3', sort: 35 },
  { id: 'S4', code: '4', name: 'Shelf 4', side: 'left', kind: 'shelf', parentId: null, sort: 40 },
  { id: 'S5', code: '5', name: 'Shelf 5', side: 'left', kind: 'shelf', parentId: null, sort: 50 },
  { id: 'S6', code: '6', name: 'Shelf 6', side: 'left', kind: 'shelf', parentId: null, sort: 60 },
  { id: 'S7', code: '7', name: 'Shelf 7', side: 'right', kind: 'shelf', parentId: null, sort: 70 },
  { id: 'S8', code: '8', name: 'Shelf 8', side: 'right', kind: 'shelf', parentId: null, sort: 80 },
  { id: 'S9', code: '9', name: 'Shelf 9', side: 'right', kind: 'shelf', parentId: null, sort: 90, tag: 'bottom' },
  { id: 'D9-1', code: '9-1', name: 'Drawer 1', side: 'right', kind: 'drawer', parentId: 'S9', sort: 91 },
  { id: 'D9-2', code: '9-2', name: 'Drawer 2', side: 'right', kind: 'drawer', parentId: 'S9', sort: 92 },
  { id: 'D9-3', code: '9-3', name: 'Drawer 3', side: 'right', kind: 'drawer', parentId: 'S9', sort: 93 },
  { id: RET_ID, code: 'RET', name: 'Return pile', side: 'none', kind: 'pile', parentId: null, sort: 900, usable: false },
];

export const UNASSIGNED = Object.freeze({ id: null, key: UNASSIGNED_KEY, code: '—', name: 'Unassigned', side: 'none', kind: 'virtual', parentId: null, sort: 999, usable: true });

export const SIDE_LABEL = { left: 'Left side', right: 'Right side', none: 'Elsewhere' };
export const KIND_LABEL = { shelf: 'Shelf', floor: 'Floor', drawer: 'Drawer', pile: 'Pile', virtual: '' };

/** Insert any seed rows that are missing (never overwrites user edits). */
export async function ensureSeed() {
  const existing = new Set((await dbAll('locations')).map(l => l.id));
  const now = Date.now();
  let added = 0;
  for (const s of SEED) {
    if (existing.has(s.id)) continue;
    await dbPut('locations', { usable: true, tag: null, ...s, createdAt: now, updatedAt: now, deletedAt: null });
    added++;
  }
  if (added) await metaSet('seedVersion', 1);
  return added;
}

export async function allLocations({ includeDeleted = false } = {}) {
  const rows = await dbAll('locations');
  return rows.filter(l => includeDeleted || !l.deletedAt).sort((a, b) => a.sort - b.sort);
}

export const getLocation = (id) => (id ? dbGet('locations', id) : Promise.resolve(null));

export function locationMap(locs) {
  return new Map(locs.map(l => [l.id, l]));
}

/** "Shelf 9 › Drawer 1" / "Shelf 3" / "Unassigned" */
export function labelOf(locOrId, map) {
  const loc = typeof locOrId === 'string' ? map.get(locOrId) : locOrId;
  if (!loc) return 'Unassigned';
  const parent = loc.parentId ? map.get(loc.parentId) : null;
  return parent ? `${parent.name} › ${loc.name}` : loc.name;
}

export function shortOf(locOrId, map) {
  const loc = typeof locOrId === 'string' ? map.get(locOrId) : locOrId;
  return loc ? loc.code : '—';
}

export const isUsable = (loc) => !loc || loc.usable !== false;
export const isReturn = (item) => item.locationId === RET_ID;
export const keyOf = (item) => item.locationId || UNASSIGNED_KEY;

/** Top-level locations with their children attached, in van order. */
export function tree(locs) {
  const top = locs.filter(l => !l.parentId).map(l => ({ loc: l, children: [] }));
  const byId = new Map(top.map(n => [n.loc.id, n]));
  for (const l of locs) {
    if (!l.parentId) continue;
    const p = byId.get(l.parentId);
    if (p) p.children.push({ loc: l, children: [] });
    else top.push({ loc: l, children: [] }); // orphan → show at top level
  }
  return top;
}

export function bySide(nodes) {
  const out = { left: [], right: [], none: [] };
  for (const n of nodes) (out[n.loc.side] || out.none).push(n);
  return out;
}

/** Ordered walk list for counts: every location (children after parents), then Unassigned, then Return. */
export function walkOrder(locs, { includeReturn = false } = {}) {
  const ids = locs.filter(l => l.id !== RET_ID).map(l => l.id);
  ids.push(UNASSIGNED_KEY);
  if (includeReturn && locs.some(l => l.id === RET_ID)) ids.push(RET_ID);
  return ids;
}

export function statsByLocation(items) {
  const map = new Map();
  for (const i of items) {
    if (i.deletedAt) continue;
    const key = keyOf(i);
    let s = map.get(key);
    if (!s) { s = { count: 0, low: 0, ea: 0, ft: 0 }; map.set(key, s); }
    s.count++;
    if (i.min > 0 && i.qty <= i.min) s.low++;
    if (i.unit === 'ft') s.ft += i.qty; else if (!i.unit || i.unit === 'ea') s.ea += i.qty;
  }
  return map;
}

export async function updateLocation(id, patch) {
  const loc = await dbGet('locations', id);
  if (!loc) throw new Error('Location not found');
  const next = { ...loc, ...patch, updatedAt: Date.now() };
  if (patch.name !== undefined) next.name = String(patch.name).trim() || loc.name;
  await dbPut('locations', next);
  notifyDataChanged({ type: 'location' });
  return next;
}

export async function addLocation({ name, code = '', side = 'left', kind = 'shelf', parentId = null }) {
  const locs = await allLocations();
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Name is required');
  const siblings = locs.filter(l => (parentId ? l.parentId === parentId : (!l.parentId && l.side === side)));
  const parent = parentId ? locs.find(l => l.id === parentId) : null;
  const base = parent ? parent.sort : (siblings.length ? Math.max(...siblings.map(l => l.sort)) : (side === 'right' ? 60 : 0));
  const sort = parent ? base + siblings.length + 1 : base + 10;
  const now = Date.now();
  const loc = {
    id: uuid(), code: String(code || '').trim() || cleanName.replace(/[^A-Za-z0-9]+/g, '').slice(0, 4).toUpperCase() || '?',
    name: cleanName, side: parent ? parent.side : side, kind, parentId, sort, usable: kind !== 'pile', tag: null,
    createdAt: now, updatedAt: now, deletedAt: null,
  };
  await dbPut('locations', loc);
  await renumber();
  notifyDataChanged({ type: 'location' });
  return loc;
}

/** Move a top-level location up/down within its side (children travel with it). */
export async function reorderLocation(id, dir) {
  const locs = await allLocations();
  const loc = locs.find(l => l.id === id);
  if (!loc || loc.parentId) return;
  const sameSide = locs.filter(l => !l.parentId && l.side === loc.side && l.id !== RET_ID);
  const idx = sameSide.findIndex(l => l.id === id);
  const swapWith = sameSide[idx + dir];
  if (!swapWith) return;
  const a = loc.sort, b = swapWith.sort;
  loc.sort = b; swapWith.sort = a;
  loc.updatedAt = swapWith.updatedAt = Date.now();
  await dbPut('locations', loc);
  await dbPut('locations', swapWith);
  await renumber();
  notifyDataChanged({ type: 'location' });
}

/** Keep sort numbers tidy: left side, right side, elsewhere; children right after parents. */
async function renumber() {
  const locs = await allLocations();
  const top = locs.filter(l => !l.parentId && l.id !== RET_ID);
  const order = [...top.filter(l => l.side === 'left'), ...top.filter(l => l.side === 'right'), ...top.filter(l => l.side === 'none')];
  let n = 10;
  const now = Date.now();
  for (const t of order) {
    if (t.sort !== n) { t.sort = n; t.updatedAt = now; await dbPut('locations', t); }
    const kids = locs.filter(l => l.parentId === t.id).sort((a, b) => a.sort - b.sort);
    kids.forEach(async (k, i) => {
      const s = n + i + 1;
      if (k.sort !== s || k.side !== t.side) { k.sort = s; k.side = t.side; k.updatedAt = now; await dbPut('locations', k); }
    });
    n += 10;
  }
}

/** Move every part on `fromId` to `intoId` (null = unassigned) and retire `fromId`. */
export async function mergeLocations(fromId, intoId) {
  if (fromId === intoId) throw new Error('Pick a different location');
  const moved = await withTx(['items', 'locations'], 'readwrite', async (t) => {
    const items = t.objectStore('items');
    const locs = t.objectStore('locations');
    const from = await reqP(locs.get(fromId));
    if (!from) throw new Error('Location not found');
    const now = Date.now();
    const onIt = await reqP(items.index('locationId').getAll(fromId));
    for (const i of onIt) { i.locationId = intoId || null; i.updatedAt = now; items.put(i); }
    const kids = await reqP(locs.index('parentId').getAll(fromId));
    for (const k of kids) { k.parentId = intoId && intoId !== fromId ? intoId : null; k.updatedAt = now; locs.put(k); }
    from.deletedAt = now; from.updatedAt = now;
    locs.put(from);
    return onIt.length;
  });
  await renumber();
  notifyDataChanged({ type: 'location' });
  return moved;
}

export const deleteLocation = (id) => mergeLocations(id, null);

export function moveItem(itemId, toLoc, { note = null, source = 'manual' } = {}) {
  return applyStockChange({ itemId, type: 'move', toLoc: toLoc || null, note, source });
}
