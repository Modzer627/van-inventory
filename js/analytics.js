// Pure analytics over parts + the movement ledger. Quantities are never summed
// across units: every metric is per unit family ('ea' pieces vs 'ft' wire).
import { round3 } from './db.js';
import { visible } from './txns.js';
import { isLow, displayName, partCompare } from './items.js';
import { RET_ID, keyOf, UNASSIGNED_KEY } from './locations.js';

export const DAY = 24 * 3600 * 1000;

export const usageRows = (txns) => txns.filter(t => t.type === 'out' && visible(t) && t.delta < 0);
export const usableItems = (items) => items.filter(i => !i.deletedAt && i.locationId !== RET_ID);
const unitOf = (x) => (x && x.unit === 'ft' ? 'ft' : 'ea');

export function tiles({ items, txns }) {
  const live = items.filter(i => !i.deletedAt);
  const usable = usableItems(live);
  const inReturn = live.length - usable.length;
  let ea = 0, ft = 0, low = 0, negative = 0;
  for (const i of usable) {
    if (unitOf(i) === 'ft') ft += i.qty; else ea += i.qty;
    if (isLow(i)) low++;
    if (i.qty < 0) negative++;
  }
  const ret = returnAging(live, txns);
  return { parts: usable.length, inReturn, unitsEa: round3(ea), unitsFt: round3(ft), low, negative, returnOldestDays: ret.length ? ret[0].days : null };
}

/** Weekly out-usage buckets for one unit family, oldest → newest, weeks start Monday. */
export function weeklyUsage(txns, { weeks = 12, unit = 'ea' } = {}) {
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(monday.getTime() - i * 7 * DAY);
    buckets.push({ start: start.getTime(), end: start.getTime() + 7 * DAY, total: 0, events: 0 });
  }
  for (const t of usageRows(txns)) {
    if (unitOf(t) !== unit) continue;
    const b = buckets.find(b => t.ts >= b.start && t.ts < b.end);
    if (b) { b.total = round3(b.total + -t.delta); b.events++; }
  }
  return buckets.map(b => {
    const d = new Date(b.start);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, hint: `Week of ${d.toLocaleDateString()} · ${b.events} removals`, value: b.total };
  });
}

/** Top parts by units removed in a window, per unit family. */
export function topParts(items, txns, { days = 30, unit = 'ea', limit = 8 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  const byId = new Map(items.map(i => [i.id, i]));
  const totals = new Map();
  for (const t of usageRows(txns)) {
    if (t.ts < sinceTs || unitOf(t) !== unit) continue;
    const row = totals.get(t.itemId) || { itemId: t.itemId, item: byId.get(t.itemId) || null, label: t.label, unit: t.unit, qty: 0, events: 0 };
    row.qty = round3(row.qty + -t.delta);
    row.events++;
    totals.set(t.itemId, row);
  }
  return [...totals.values()].sort((a, b) => b.qty - a.qty).slice(0, limit);
}

export function usageByType(items, txns, { days = 90 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  const byId = new Map(items.map(i => [i.id, i]));
  const totals = new Map();
  for (const t of usageRows(txns)) {
    if (t.ts < sinceTs || unitOf(t) !== 'ea') continue;
    const it = byId.get(t.itemId);
    const key = (it && it.type) || '(untyped)';
    const row = totals.get(key) || { type: key, qty: 0, events: 0 };
    row.qty = round3(row.qty + -t.delta);
    row.events++;
    totals.set(key, row);
  }
  return [...totals.values()].sort((a, b) => b.qty - a.qty);
}

/** Trailing usage rate per part → days of stock left. Map itemId → row. */
export function usageRates(items, txns, { days = 90 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  const used = new Map();
  for (const t of usageRows(txns)) {
    if (t.ts < sinceTs) continue;
    used.set(t.itemId, round3((used.get(t.itemId) || 0) + -t.delta));
  }
  const map = new Map();
  for (const item of items) {
    const total = used.get(item.id);
    if (!total) continue;
    const perDay = total / days;
    map.set(item.id, { item, perDay: round3(perDay), used: total, daysLeft: item.qty > 0 ? Math.floor(item.qty / perDay) : 0 });
  }
  return map;
}

/**
 * Reorder list: at/below min, or forecast to run out within `horizonDays`.
 * Suggested = enough to reach max(2×min, coverDays of usage). Parts with no
 * min and no usage are never flagged (StockTracker's 0/0 bug).
 */
export function reorderList(items, txns, { horizonDays = 21, coverDays = 30 } = {}) {
  const rates = usageRates(items, txns, { days: 90 });
  const rows = [];
  for (const item of usableItems(items)) {
    const r = rates.get(item.id);
    const low = isLow(item);
    const runningOut = !!r && r.daysLeft <= horizonDays;
    if (!low && !runningOut) continue;
    const perDay = r ? r.perDay : 0;
    const target = Math.max((item.min || 0) * 2, perDay * coverDays, item.min || 0);
    const suggested = Math.max(1, Math.ceil(target - item.qty));
    rows.push({ item, low, perDay, daysLeft: r ? r.daysLeft : null, suggested });
  }
  return rows.sort((a, b) => {
    const da = a.daysLeft ?? 9999, db = b.daysLeft ?? 9999;
    return da - db || (b.low - a.low) || partCompare(a.item, b.item);
  });
}

/** Parts with stock that have not been removed for `days`. */
export function deadStock(items, txns, { days = 180, firstTxnAt = null } = {}) {
  const lastOut = new Map();
  for (const t of usageRows(txns)) lastOut.set(t.itemId, Math.max(lastOut.get(t.itemId) || 0, t.ts));
  const now = Date.now();
  const historyDays = firstTxnAt ? Math.floor((now - firstTxnAt) / DAY) : 0;
  const rows = [];
  for (const item of usableItems(items)) {
    if (!(item.qty > 0)) continue;
    const last = lastOut.get(item.id) || 0;
    if (last && now - last < days * DAY) continue;
    const idleSince = Math.max(last, item.createdAt || 0);
    const idleDays = Math.floor((now - idleSince) / DAY);
    if (idleDays < days) continue;
    rows.push({ item, idleDays, lastOutTs: last || null });
  }
  rows.sort((a, b) => b.idleDays - a.idleDays || partCompare(a.item, b.item));
  return { rows, historyDays, enough: historyDays >= days };
}

/** Parts in the Return pile with how long they have sat there. */
export function returnAging(items, txns) {
  const since = new Map();
  for (const t of txns) {
    if (!visible(t) || t.type !== 'move' || t.toLoc !== RET_ID) continue;
    since.set(t.itemId, Math.max(since.get(t.itemId) || 0, t.ts));
  }
  const now = Date.now();
  const rows = [];
  for (const item of items) {
    if (item.deletedAt || item.locationId !== RET_ID) continue;
    const sinceTs = since.get(item.id) || item.lastMovedAt || item.createdAt || now;
    rows.push({ item, sinceTs, days: Math.floor((now - sinceTs) / DAY) });
  }
  return rows.sort((a, b) => b.days - a.days || partCompare(a.item, b.item));
}

/** Activity per location over a window, in van order. */
export function busiestLocations(txns, locations, { days = 90 } = {}) {
  const sinceTs = Date.now() - days * DAY;
  const rows = new Map();
  const bump = (key, field, amt = 1) => {
    let r = rows.get(key);
    if (!r) { r = { key, events: 0, ea: 0, ft: 0, moves: 0 }; rows.set(key, r); }
    r[field] = round3(r[field] + amt);
  };
  for (const t of txns) {
    if (!visible(t) || t.ts < sinceTs) continue;
    if (t.type === 'in' || t.type === 'out') {
      const key = t.locationId || UNASSIGNED_KEY;
      bump(key, 'events');
      bump(key, unitOf(t), Math.abs(t.delta));
    } else if (t.type === 'move') {
      bump(t.toLoc || UNASSIGNED_KEY, 'moves');
    }
  }
  const order = [...locations.map(l => l.id), UNASSIGNED_KEY];
  return order.map(k => rows.get(k)).filter(Boolean);
}

/** Parts that need a human look: negative, verify flag, lost digits, no barcode. */
export function needsVerification(items, codesByItem) {
  const rows = [];
  for (const item of items) {
    if (item.deletedAt) continue;
    const reasons = [];
    if (item.qty < 0) reasons.push('below zero');
    if (item.flags && item.flags.verify) reasons.push('amount unclear in the sheet');
    const codes = codesByItem.get(item.id) || [];
    if (!codes.length) reasons.push('no barcode');
    if (codes.some(c => c.flags && c.flags.precisionLost)) reasons.push('a code lost digits in Excel');
    if (reasons.length) rows.push({ item, reasons });
  }
  return rows.sort((a, b) => partCompare(a.item, b.item));
}

/** Movement counts since `sinceTs` (this quarter). */
export function activitySince(txns, sinceTs) {
  const out = { removals: 0, additions: 0, moves: 0, counts: 0, unitsEa: 0, unitsFt: 0 };
  for (const t of txns) {
    if (!visible(t) || t.ts < sinceTs) continue;
    if (t.type === 'out') { out.removals++; if (unitOf(t) === 'ft') out.unitsFt = round3(out.unitsFt + -t.delta); else out.unitsEa = round3(out.unitsEa + -t.delta); }
    else if (t.type === 'in') out.additions++;
    else if (t.type === 'move') out.moves++;
    else if (t.type === 'count' && t.delta !== 0) out.counts++;
  }
  return out;
}

export { displayName, keyOf };
