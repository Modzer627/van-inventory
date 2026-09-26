// Pure spreadsheet → rows parser shared by the browser importer and
// tools/import-check.mjs. No DOM, no IndexedDB.
import { classifyCode } from './codes.js';

export const HEADER_ALIASES = {
  brand: ['brand', 'manufacturer', 'mfr', 'make'],
  model: ['model', 'part', 'part number', 'part #', 'part no', 'part no.', 'model number', 'item name', 'name', 'sku'],
  qty: ['ammount', 'amount', 'qty', 'quantity', 'count', 'on hand', 'stock', 'in stock'],
  barcode: ['barcode', 'upc', 'ean', 'code', 'bar code'],
  type: ['item type', 'type', 'category', 'cat'],
  shelf: ['shelf', 'location', 'loc', 'bin', 'where'],
  min: ['min', 'min stock', 'minimum', 'reorder', 'reorder point', 'min qty'],
  unit: ['unit', 'uom', 'units'],
  notes: ['notes', 'note', 'comments', 'comment'],
  extras: ['extras', 'extra', 'other barcodes', 'other codes', 'aliases', 'alt barcode'],
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Quote-aware CSV parser (SheetJS coerces CSV cells, so CSVs are parsed by hand). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

/** Excel numbers → exact-looking strings (no exponents); everything else trimmed. */
export function cellStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (Math.abs(v) < 1e21) return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
      return BigInt(v).toString();
    }
    return String(v);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** "114FT" → {qty:114, unit:'ft'}; "-" / blank → {qty:0, verify:true}. */
export function parseQty(v) {
  if (typeof v === 'number') return { qty: v, unit: null, verify: false };
  const s = String(v ?? '').trim();
  if (!s || s === '-' || s === '—') return { qty: 0, unit: null, verify: true };
  let m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(ft|feet|foot|')\s*$/i);
  if (m) return { qty: parseFloat(m[1].replace(',', '.')), unit: 'ft', verify: false };
  m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(ea|pcs?|each)?\s*$/i);
  if (m) return { qty: parseFloat(m[1].replace(',', '.')), unit: null, verify: false };
  return { qty: 0, unit: null, verify: true, raw: s };
}

/** Find the header row and column mapping. */
export function detectHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const row = (grid[r] || []).map(norm);
    const colFor = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const idx = row.findIndex(h => h && aliases.includes(h));
      if (idx !== -1) colFor[field] = idx;
    }
    if (colFor.model !== undefined && (colFor.brand !== undefined || colFor.qty !== undefined || colFor.barcode !== undefined)) {
      // Extras: the EXTRAS column and every column to its right that has no header of its own.
      const extrasCols = [];
      if (colFor.extras !== undefined) {
        const used = new Set(Object.values(colFor));
        for (let c = colFor.extras; c < Math.max(row.length, ...grid.slice(r + 1, r + 50).map(x => (x || []).length)); c++) {
          if (c !== colFor.extras && used.has(c)) break;
          if (c !== colFor.extras && row[c]) break; // a real header → not an extras column
          extrasCols.push(c);
        }
      }
      return { rowIdx: r, colFor, extrasCols, headers: grid[r].map(h => cellStr(h)) };
    }
  }
  return null;
}

/**
 * Default shelf resolver: returns a locationId, null (unassigned) or undefined (unknown).
 * `locations` = live location rows (id, code, name).
 */
export function makeShelfResolver(locations = []) {
  const byCode = new Map(), byName = new Map(), byId = new Map();
  for (const l of locations) {
    byCode.set(norm(l.code), l.id);
    byName.set(norm(l.name), l.id);
    byId.set(norm(l.id), l.id);
  }
  return (raw) => {
    const s = norm(raw);
    if (!s) return null;
    if (s === '3-5') return byId.get('f3') ?? 'F3';
    if (s === 'return' || s === 'ret' || s === 'returns') return byId.get('ret') ?? 'RET';
    if (s === 'unassigned' || s === 'none') return null;
    if (/^[1-9]$/.test(s)) return byId.get('s' + s) ?? ('S' + s);
    if (/^shelf\s*[1-9]$/.test(s)) return byId.get('s' + s.replace(/\D/g, '')) ?? ('S' + s.replace(/\D/g, ''));
    if (/^9-[1-3]$/.test(s)) return byId.get('d' + s) ?? ('D' + s.toUpperCase());
    if (byCode.has(s)) return byCode.get(s);
    if (byName.has(s)) return byName.get(s);
    if (byId.has(s)) return byId.get(s);
    return undefined;
  };
}

/**
 * Parse a grid (array of arrays) into normalized rows + a report.
 * opts.resolveShelf(raw) → locationId | null | undefined
 * opts.shelfOverrides { rawLower: locationId|null } (from the preview's mapping table)
 */
export function parseGrid(grid, { resolveShelf = makeShelfResolver([]), shelfOverrides = {}, fileName = '' } = {}) {
  const head = detectHeader(grid);
  if (!head) throw new Error('Could not find the header row (needs at least Model plus Brand, Amount or Barcode columns)');
  const { rowIdx, colFor, extrasCols } = head;

  const rows = [];
  const report = {
    fileName, headerRow: rowIdx + 1, mapped: Object.keys(colFor).filter(k => k !== 'extras'),
    extrasCols: extrasCols.length, skippedBlank: 0, skippedNoModel: 0,
    shelfValues: {}, unknownShelves: [], codeStats: { upc: 0, ean: 0, mfr: 0, reel: 0, serial: 0, manual: 0, none: 0, fixedLeadingZero: 0, precisionLost: 0 },
    aliasCount: 0, ftCount: 0, verifyCount: 0, duplicateCodes: [], typeCount: 0,
  };
  const seenCodes = new Map(); // norm → rowNo

  for (let r = rowIdx + 1; r < grid.length; r++) {
    const line = grid[r] || [];
    const get = (f) => (colFor[f] === undefined ? '' : cellStr(line[colFor[f]]));
    const rawCells = Object.values(colFor).filter(c => c !== colFor.extras).map(c => cellStr(line[c]));
    if (rawCells.every(v => v === '')) { report.skippedBlank++; continue; }
    const model = get('model');
    if (!model) { report.skippedNoModel++; continue; }
    const brand = get('brand');
    const qtyCell = colFor.qty === undefined ? '' : line[colFor.qty];
    const q = parseQty(qtyCell);
    const unitCell = get('unit').toLowerCase();
    const unit = q.unit || (unitCell === 'ft' || unitCell === 'feet' ? 'ft' : 'ea');
    const shelfRaw = get('shelf');
    const shelfKey = norm(shelfRaw);
    report.shelfValues[shelfRaw || '(blank)'] = (report.shelfValues[shelfRaw || '(blank)'] || 0) + 1;
    let locationId = shelfOverrides[shelfKey] !== undefined ? shelfOverrides[shelfKey] : resolveShelf(shelfRaw);
    let locationUnknown = false;
    if (locationId === undefined) { locationUnknown = true; locationId = null; if (shelfRaw && !report.unknownShelves.includes(shelfRaw)) report.unknownShelves.push(shelfRaw); }

    const warnings = [];
    const codes = [];
    const addCode = (raw, role) => {
      const cls = classifyCode(raw, 'import');
      if (!cls) return;
      if (codes.some(c => c.norm === cls.norm)) return;
      const prev = seenCodes.get(cls.norm);
      if (prev !== undefined && prev !== r + 1) {
        report.duplicateCodes.push({ code: cls.code, rows: [prev, r + 1] });
        warnings.push(`code ${cls.code} already used on row ${prev}`);
        return;
      }
      seenCodes.set(cls.norm, r + 1);
      cls.role = role;
      codes.push(cls);
      report.codeStats[cls.kind] = (report.codeStats[cls.kind] || 0) + 1;
      if (cls.flags.fixedLeadingZero) report.codeStats.fixedLeadingZero++;
      if (cls.flags.precisionLost) { report.codeStats.precisionLost++; warnings.push(`${cls.code} lost digits in Excel — re-scan the label`); }
    };
    const primaryRaw = get('barcode');
    if (primaryRaw) addCode(primaryRaw, 'primary'); else report.codeStats.none++;
    for (const c of extrasCols) {
      const v = cellStr(line[c]);
      if (v) { const before = codes.length; addCode(v, 'extra'); if (codes.length > before) report.aliasCount++; }
    }
    const type = get('type');
    if (type) report.typeCount++;
    if (unit === 'ft') report.ftCount++;
    if (q.verify) { report.verifyCount++; warnings.push(q.raw ? `amount "${q.raw}" not understood` : 'amount missing'); }

    rows.push({
      rowNo: r + 1, brand, model, type: type.toUpperCase(), qty: q.qty, unit,
      min: get('min') ? parseFloat(get('min').replace(',', '.')) || null : null,
      notes: get('notes'), shelfRaw, locationId, locationUnknown,
      flags: { ...(q.verify ? { verify: true } : {}), ...(codes.some(c => c.flags.precisionLost) ? { precisionLost: true } : {}) },
      codes, warnings,
    });
  }
  return { rows, report, header: head };
}
