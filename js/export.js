// Excel / CSV export via the vendored SheetJS build, delivered through the
// native share sheet on phones or a plain download elsewhere.
import { isoDate, fmtQty, toast } from './ui.js';
import { displayName, isLow, partCompare } from './items.js';
import { primaryCode, otherCodes } from './barcodes.js';
import { labelOf, locationMap, keyOf, RET_ID, UNASSIGNED_KEY, SIDE_LABEL } from './locations.js';
import { visible, TYPE_LABEL } from './txns.js';
import { reorderList, returnAging } from './analytics.js';
import { compareSnapshots } from './counts.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function stamp(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const dateOnly = (ts) => (ts ? isoDate(ts) : '');
const timeOnly = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const n = (v) => Number(fmtQty(v));
const unitOut = (u) => (u === 'ea' || !u ? 'pcs' : u);

function ensureXlsx() {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded yet — try again', { error: true }); return false; }
  return true;
}

function sheetFrom(rows, widths, name, wb) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
  if (rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: rows[0].length - 1, r: rows.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  return ws;
}

/** Sort parts by van order (shelf sort, unassigned, return), then brand/model. */
export function vanSort(items, locations) {
  const sortOf = new Map(locations.map(l => [l.id, l.sort]));
  const key = (i) => (i.locationId ? (sortOf.get(i.locationId) ?? 950) : 990);
  return [...items].sort((a, b) => key(a) - key(b) || partCompare(a, b));
}

function movementRows(txns, items, locMap, { sinceTs = 0, untilTs = Infinity } = {}) {
  const byId = new Map(items.map(i => [i.id, i]));
  const rows = [['Date', 'Time', 'Brand', 'Model', 'Action', 'Change', 'Unit', 'After', 'From', 'To', 'Job', 'Note']];
  for (const t of txns) {
    if (!visible(t) || t.ts < sinceTs || t.ts > untilTs) continue;
    if (t.type === 'count' && t.delta === 0) continue; // "counted, matched" rows are noise here
    const it = byId.get(t.itemId);
    const [brand, model] = it ? [it.brand, it.model] : (t.label || '').split(/ (.+)/);
    rows.push([
      dateOnly(t.ts), timeOnly(t.ts), brand || '', model || '', TYPE_LABEL[t.type] || t.type,
      t.type === 'move' ? '' : n(t.delta), unitOut(t.unit), t.type === 'move' ? '' : n(t.qtyAfter),
      t.type === 'move' ? labelOf(t.fromLoc, locMap) : '', t.type === 'move' ? labelOf(t.toLoc, locMap) : '',
      t.jobRef || '', t.note || '',
    ]);
  }
  return rows;
}

/**
 * Inventory workbook: Inventory · By shelf · Low stock · Return pile · Movements.
 * period: { sinceTs, label }
 */
export function buildInventoryWorkbook({ items, codesByItem, locations, txns, period = null }) {
  const wb = XLSX.utils.book_new();
  const locMap = locationMap(locations);
  const live = items.filter(i => !i.deletedAt);
  const sorted = vanSort(live, locations);

  const inv = [['Brand', 'Model', 'Type', 'Shelf', 'Qty', 'Unit', 'Barcode', 'Other barcodes', 'Min', 'Last counted', 'Last moved', 'Notes', 'Flags']];
  for (const i of sorted) {
    const codes = codesByItem.get(i.id) || [];
    const flags = [];
    if (i.flags && i.flags.verify) flags.push('VERIFY');
    if (i.qty < 0) flags.push('NEGATIVE');
    if (isLow(i)) flags.push('LOW');
    if (!codes.length) flags.push('NO BARCODE');
    inv.push([
      i.brand, i.model, i.type || '', labelOf(i.locationId, locMap), n(i.qty), unitOut(i.unit),
      primaryCode(codes), otherCodes(codes).join('; '), i.min ?? '', dateOnly(i.lastCountedAt), dateOnly(i.lastMovedAt),
      i.notes || '', flags.join(', '),
    ]);
  }
  sheetFrom(inv, [14, 24, 14, 20, 7, 6, 16, 30, 5, 12, 12, 30, 14], 'Inventory', wb);

  // By shelf summary
  const rowsBy = [['Shelf', 'Side', 'Parts', 'Low', 'Units (pcs)', 'Wire (ft)']];
  const stats = new Map();
  for (const i of live) {
    const k = keyOf(i);
    const s = stats.get(k) || { count: 0, low: 0, ea: 0, ft: 0 };
    s.count++; if (isLow(i)) s.low++;
    if (i.unit === 'ft') s.ft += i.qty; else s.ea += i.qty;
    stats.set(k, s);
  }
  const shelfOrder = [...locations.map(l => l.id), UNASSIGNED_KEY];
  for (const k of shelfOrder) {
    const s = stats.get(k);
    const loc = locMap.get(k);
    if (!s && !loc) continue;
    rowsBy.push([k === UNASSIGNED_KEY ? 'Unassigned' : labelOf(k, locMap), loc ? (SIDE_LABEL[loc.side] || '') : '', s ? s.count : 0, s ? s.low : 0, s ? n(s.ea) : 0, s ? n(s.ft) : 0]);
  }
  sheetFrom(rowsBy, [22, 12, 7, 6, 11, 10], 'By shelf', wb);

  // Low stock / reorder
  const reorder = reorderList(live, txns);
  const lowRows = [['Brand', 'Model', 'Shelf', 'Qty', 'Unit', 'Min', 'Days left', 'Suggested order']];
  for (const r of reorder) lowRows.push([r.item.brand, r.item.model, labelOf(r.item.locationId, locMap), n(r.item.qty), unitOut(r.item.unit), r.item.min ?? '', r.daysLeft ?? '', r.suggested]);
  sheetFrom(lowRows, [14, 24, 20, 7, 6, 5, 9, 15], 'Low stock', wb);

  // Return pile
  const ret = returnAging(live, txns);
  const retRows = [['Brand', 'Model', 'Type', 'Qty', 'Unit', 'In pile since', 'Days']];
  for (const r of ret) retRows.push([r.item.brand, r.item.model, r.item.type || '', n(r.item.qty), unitOut(r.item.unit), dateOnly(r.sinceTs), r.days]);
  sheetFrom(retRows, [14, 24, 14, 7, 6, 13, 6], 'Return pile', wb);

  // Movements
  const sinceTs = period && period.sinceTs ? period.sinceTs : 0;
  sheetFrom(movementRows(txns, items, locMap, { sinceTs }), [11, 6, 14, 24, 10, 8, 6, 7, 18, 18, 18, 30], period && period.label ? `Movements (${period.label})` : 'Movements', wb);

  return wb;
}

/** Count workbook: Summary · Variances · Snapshot · Compare · Movements since previous. */
export function buildCountWorkbook({ count, prev, locations, txns, items }) {
  const wb = XLSX.utils.book_new();
  const locMap = locationMap(locations);
  const s = count.stats || {};
  const summary = [
    ['Van inventory count', count.label],
    ['Started', stamp(count.startedAt)],
    ['Committed', stamp(count.committedAt)],
    ['Parts in van', s.parts ?? ''],
    ['Parts counted', s.counted ?? ''],
    ['Quantities adjusted', s.adjusted ?? ''],
    ['Uncounted set to zero', s.zeroed ?? 0],
    ['Scope', count.scope && count.scope.all ? 'Whole van' : (count.order || []).map(k => k === UNASSIGNED_KEY ? 'Unassigned' : labelOf(k, locMap)).join(', ')],
    ['Previous count', prev ? `${prev.label} (${dateOnly(prev.committedAt)})` : 'none'],
    ['Note', count.note || ''],
  ];
  const wsS = XLSX.utils.aoa_to_sheet(summary);
  wsS['!cols'] = [{ wch: 22 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsS, 'Summary');

  const vRows = [['Brand', 'Model', 'Shelf', 'Unit', 'Expected', 'Counted', 'Difference']];
  for (const v of count.variances || []) {
    const [brand, model] = (v.label || '').split(/ (.+)/);
    vRows.push([brand || '', model || '', labelOf(v.locationId, locMap), unitOut(v.unit), n(v.expected), n(v.counted), n(v.diff)]);
  }
  sheetFrom(vRows, [14, 24, 20, 6, 9, 9, 10], 'Variances', wb);

  const snapRows = [['Brand', 'Model', 'Type', 'Shelf', 'Qty', 'Unit', 'Min', 'Counted']];
  const snap = [...(count.snapshot || [])].sort((a, b) => (a.locationName || 'zz').localeCompare(b.locationName || 'zz') || partCompare(a, b));
  for (const r of snap) snapRows.push([r.brand, r.model, r.type || '', r.locationName || 'Unassigned', n(r.qty), unitOut(r.unit), r.min ?? '', r.counted ? 'yes' : 'no']);
  sheetFrom(snapRows, [14, 24, 14, 20, 7, 6, 5, 8], 'Snapshot', wb);

  if (prev && prev.snapshot) {
    const cmp = compareSnapshots(count, prev);
    const cRows = [['Brand', 'Model', 'Unit', `Prev (${prev.label})`, `Now (${count.label})`, 'Change', 'Status']];
    for (const r of cmp.rows) cRows.push([r.brand, r.model, unitOut(r.unit), r.prevQty ?? '', r.currQty ?? '', n(r.change), r.status]);
    sheetFrom(cRows, [14, 24, 6, 12, 12, 8, 9], 'Compare', wb);
    sheetFrom(movementRows(txns, items, locMap, { sinceTs: prev.committedAt, untilTs: count.committedAt }), [11, 6, 14, 24, 10, 8, 6, 7, 18, 18, 18, 30], 'Movements since prev', wb);
  } else {
    sheetFrom(movementRows(txns, items, locMap, { untilTs: count.committedAt }), [11, 6, 14, 24, 10, 8, 6, 7, 18, 18, 18, 30], 'Movements', wb);
  }
  return wb;
}

export function buildInventoryCsv({ items, codesByItem, locations }) {
  const locMap = locationMap(locations);
  const q = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Brand', 'Model', 'Type', 'Shelf', 'Qty', 'Unit', 'Barcode', 'Other barcodes', 'Min', 'Notes'].join(',')];
  for (const i of vanSort(items.filter(i => !i.deletedAt), locations)) {
    const codes = codesByItem.get(i.id) || [];
    lines.push([i.brand, i.model, i.type || '', labelOf(i.locationId, locMap), fmtQty(i.qty), unitOut(i.unit), primaryCode(codes), otherCodes(codes).join('; '), i.min ?? '', i.notes || ''].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Hand a file to the user. Phones (touch devices) get the share sheet when the
 * browser supports sharing files; everything else gets a download.
 * Returns 'shared' | 'downloaded' | 'cancelled'.
 */
export async function deliverFile(filename, data, mime) {
  const file = new File([data], filename, { type: mime });
  const preferShare = navigator.maxTouchPoints > 0 && navigator.canShare && navigator.canShare({ files: [file] });
  if (preferShare) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

export function workbookToArray(wb) {
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

export async function exportInventoryXlsx(data) {
  if (!ensureXlsx()) return null;
  const wb = buildInventoryWorkbook(data);
  const label = data.period && data.period.label ? `-${data.period.label.replace(/[^A-Za-z0-9]+/g, '-')}` : '';
  return deliverFile(`Van-Inventory-${isoDate()}${label}.xlsx`, workbookToArray(wb), XLSX_MIME);
}

export async function exportCountXlsx(data) {
  if (!ensureXlsx()) return null;
  const wb = buildCountWorkbook(data);
  return deliverFile(`Van-Count-${data.count.label.replace(/[^A-Za-z0-9]+/g, '-')}.xlsx`, workbookToArray(wb), XLSX_MIME);
}

export async function exportInventoryCsv(data) {
  return deliverFile(`Van-Inventory-${isoDate()}.csv`, buildInventoryCsv(data), 'text/csv');
}

export { displayName };
