// Count sessions (quarterly stocktakes): walk the van location by location,
// review variances, commit in one transaction, keep a snapshot per count.
import { uuid, round3, dbGet, dbAll, dbPut, withTx, reqP, metaGet, metaSet, notifyDataChanged, deviceId } from './db.js';
import { allLocations, walkOrder, keyOf, RET_ID, UNASSIGNED_KEY } from './locations.js';
import { displayName, partCompare } from './items.js';

const DAY = 24 * 3600 * 1000;

export function quarterOf(ts = Date.now()) {
  const d = new Date(ts);
  return { q: Math.floor(d.getMonth() / 3) + 1, y: d.getFullYear() };
}
export function quarterLabel(ts = Date.now()) {
  const { q, y } = quarterOf(ts);
  return `Q${q} ${y}`;
}
export function quarterStart(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
}
export function quarterEnd(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 0, 23, 59, 59, 999).getTime();
}
export function daysToQuarterEnd(ts = Date.now()) {
  return Math.max(0, Math.ceil((quarterEnd(ts) - ts) / DAY));
}

export async function openCount() {
  const id = await metaGet('openCountId', null);
  if (!id) return null;
  const rec = await dbGet('counts', id);
  if (!rec || rec.committedAt || rec.discardedAt) { await metaSet('openCountId', null); return null; }
  return rec;
}

export async function committedCounts() {
  const rows = await dbAll('counts');
  return rows.filter(c => c.committedAt).sort((a, b) => b.committedAt - a.committedAt);
}

export async function latestCommitted() {
  return (await committedCounts())[0] || null;
}

export async function suggestLabel() {
  const base = quarterLabel();
  const taken = new Set((await committedCounts()).map(c => c.label));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/**
 * scope: { all: true } or { locationIds: [...] } (UNASSIGNED_KEY allowed).
 */
export async function startCount({ label, scope = { all: true }, includeReturn = false, note = '' }) {
  if (await openCount()) throw new Error('A count is already in progress');
  const locs = await allLocations();
  let order = walkOrder(locs, { includeReturn });
  if (!scope.all) {
    const want = new Set(scope.locationIds || []);
    order = order.filter(id => want.has(id) || (id === RET_ID && includeReturn));
  }
  if (!order.length) throw new Error('Pick at least one location');
  const now = Date.now();
  const rec = {
    id: uuid(), label: String(label || quarterLabel()).trim() || quarterLabel(), note: String(note || '').trim(),
    startedAt: now, committedAt: null, discardedAt: null,
    scope, includeReturn, order, cursor: order[0], lines: {},
    snapshot: null, variances: null, prevCountId: null, stats: null, zeroUncounted: false, updatedAt: now,
  };
  await dbPut('counts', rec);
  await metaSet('openCountId', rec.id);
  notifyDataChanged({ type: 'count' });
  return rec;
}

export async function saveCount(rec) {
  rec.updatedAt = Date.now();
  await dbPut('counts', rec);
  return rec;
}

export function setLine(rec, item, counted, locationKey = null) {
  const prev = rec.lines[item.id];
  rec.lines[item.id] = {
    counted: round3(counted),
    expectedAtCount: prev ? prev.expectedAtCount : round3(item.qty || 0),
    locationKey: locationKey || keyOf(item),
    at: Date.now(),
  };
  return rec.lines[item.id];
}

export function tally(rec, item, step = 1, locationKey = null) {
  const cur = rec.lines[item.id] ? rec.lines[item.id].counted : 0;
  return setLine(rec, item, cur + step, locationKey).counted;
}

export function clearLine(rec, itemId) {
  delete rec.lines[itemId];
}

export const inScope = (rec, item) => !item.deletedAt && rec.order.includes(keyOf(item));
export const itemsAt = (items, key) => items.filter(i => !i.deletedAt && keyOf(i) === key).sort(partCompare);

export function progress(rec, items) {
  const scoped = items.filter(i => inScope(rec, i));
  const counted = scoped.filter(i => rec.lines[i.id]).length;
  return { total: scoped.length, counted, pct: scoped.length ? Math.round(counted / scoped.length * 100) : 0 };
}

export function progressAt(rec, items, key) {
  const here = itemsAt(items, key);
  const counted = here.filter(i => rec.lines[i.id]).length;
  return { total: here.length, counted };
}

export function buildReview(rec, items) {
  const counted = [];
  const uncounted = [];
  for (const item of items) {
    if (item.deletedAt) continue;
    const line = rec.lines[item.id];
    if (line) {
      const expected = round3(item.qty || 0);
      counted.push({ item, expected, counted: line.counted, diff: round3(line.counted - expected), movedSince: expected !== line.expectedAtCount, line });
    } else if (inScope(rec, item)) {
      uncounted.push(item);
    }
  }
  counted.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || partCompare(a.item, b.item));
  uncounted.sort(partCompare);
  return { counted, uncounted, variances: counted.filter(r => r.diff !== 0).length };
}

/** Write every counted quantity + a snapshot of the whole van in ONE transaction. */
export async function commitCount(rec, { zeroUncounted = false } = {}) {
  const committed = await withTx(['items', 'txns', 'counts', 'locations'], 'readwrite', async (t) => {
    const items = t.objectStore('items');
    const txns = t.objectStore('txns');
    const counts = t.objectStore('counts');
    const locs = await reqP(t.objectStore('locations').getAll());
    const locName = new Map(locs.map(l => [l.id, l.parentId ? `${(locs.find(p => p.id === l.parentId) || {}).name || ''} › ${l.name}` : l.name]));
    const all = await reqP(items.getAll());
    const live = all.filter(i => !i.deletedAt);
    const now = Date.now();
    let counted = 0, adjusted = 0, zeroed = 0;
    const variances = [];
    for (const item of live) {
      const line = rec.lines[item.id];
      let target = null;
      let noteExtra = '';
      if (line) { target = line.counted; counted++; }
      else if (zeroUncounted && inScope(rec, item)) { target = 0; zeroed++; noteExtra = ' (not counted → 0)'; }
      if (target === null) continue;
      const before = round3(item.qty || 0);
      const d = round3(target - before);
      if (d !== 0) { adjusted++; variances.push({ itemId: item.id, label: displayName(item), unit: item.unit, expected: before, counted: round3(target), diff: d, locationId: item.locationId ?? null }); }
      item.qty = round3(target);
      item.lastCountedAt = now;
      item.updatedAt = now;
      items.put(item);
      txns.add({
        id: uuid(), ts: now, itemId: item.id, label: displayName(item), unit: item.unit || 'ea',
        type: 'count', delta: d, qtyAfter: item.qty, locationId: item.locationId ?? null,
        fromLoc: null, toLoc: null, note: `Count ${rec.label}${noteExtra}`, jobRef: null,
        source: 'count', countId: rec.id, reverses: null, voided: 0, deviceId: deviceId(),
      });
    }
    const snapshot = live.map(i => ({
      itemId: i.id, brand: i.brand, model: i.model, type: i.type, unit: i.unit, qty: i.qty, min: i.min,
      locationId: i.locationId ?? null, locationName: i.locationId ? (locName.get(i.locationId) || '') : 'Unassigned',
      counted: !!rec.lines[i.id],
    }));
    const allCounts = await reqP(counts.getAll());
    const prev = allCounts.filter(c => c.committedAt && c.id !== rec.id).sort((a, b) => b.committedAt - a.committedAt)[0];
    rec.committedAt = now;
    rec.snapshot = snapshot;
    rec.variances = variances;
    rec.prevCountId = prev ? prev.id : null;
    rec.stats = { counted, adjusted, zeroed, parts: live.length };
    rec.zeroUncounted = zeroUncounted;
    rec.updatedAt = now;
    counts.put(rec);
    return rec;
  });
  await metaSet('openCountId', null);
  notifyDataChanged({ type: 'count' });
  return committed;
}

export async function discardCount(rec) {
  rec.discardedAt = Date.now();
  rec.updatedAt = rec.discardedAt;
  await dbPut('counts', rec);
  await metaSet('openCountId', null);
  notifyDataChanged({ type: 'count' });
}

/** Compare two committed snapshots. Rows sorted by |change| desc. */
export function compareSnapshots(curr, prev) {
  const a = new Map((curr.snapshot || []).map(s => [s.itemId, s]));
  const b = new Map((prev && prev.snapshot ? prev.snapshot : []).map(s => [s.itemId, s]));
  const rows = [];
  const ids = new Set([...a.keys(), ...b.keys()]);
  for (const id of ids) {
    const c = a.get(id), p = b.get(id);
    const currQty = c ? c.qty : null, prevQty = p ? p.qty : null;
    const src = c || p;
    const change = round3((currQty ?? 0) - (prevQty ?? 0));
    rows.push({
      itemId: id, brand: src.brand, model: src.model, unit: src.unit, type: src.type,
      locationName: (c || p).locationName, prevQty, currQty, change,
      status: !p ? 'new' : !c ? 'gone' : change !== 0 ? 'changed' : 'same',
    });
  }
  rows.sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || (x.brand || '').localeCompare(y.brand || '') || (x.model || '').localeCompare(y.model || ''));
  const totals = { ea: { prev: 0, curr: 0 }, ft: { prev: 0, curr: 0 } };
  for (const r of rows) {
    const u = r.unit === 'ft' ? 'ft' : 'ea';
    totals[u].prev += r.prevQty || 0;
    totals[u].curr += r.currQty || 0;
  }
  return { rows, totals, added: rows.filter(r => r.status === 'new').length, removed: rows.filter(r => r.status === 'gone').length, changed: rows.filter(r => r.status === 'changed').length };
}

/** True when a count for the current quarter has been committed. */
export async function countedThisQuarter() {
  const start = quarterStart();
  return (await committedCounts()).some(c => c.committedAt >= start);
}

export { UNASSIGNED_KEY };
