// Spreadsheet import: read the file, parse with import-parse.js, match against
// the database, then create/update everything in ONE transaction.
import { parseGrid, parseCsv, makeShelfResolver } from './import-parse.js';
import { allLocations } from './locations.js';
import { allParts, normalizePart, makeCodeRec, ledgerRow, displayName } from './items.js';
import { codesByItem } from './barcodes.js';
import { uuid, round3, withTx, reqP, metaGet, metaSet, notifyDataChanged } from './db.js';

export async function readGrid(file) {
  if (/\.csv$/i.test(file.name) || (file.type || '').includes('csv')) {
    return parseCsv(await file.text());
  }
  if (typeof XLSX === 'undefined') throw new Error('Spreadsheet library not loaded yet — try again');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('No sheet found in that file');
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

/** Parse + match. Re-callable with shelfOverrides from the preview's mapping table. */
export async function analyzeGrid(grid, { fileName = '', shelfOverrides = {} } = {}) {
  const locations = await allLocations();
  const parsed = parseGrid(grid, { resolveShelf: makeShelfResolver(locations), shelfOverrides, fileName });
  const existing = await allParts();
  const codes = await codesByItem();
  const codeIndex = new Map();
  for (const [itemId, recs] of codes) for (const r of recs) codeIndex.set(r.norm, itemId);
  const nameIndex = new Map(existing.map(i => [i.nameKey, i.id]));
  const byId = new Map(existing.map(i => [i.id, i]));

  let newCount = 0, existingCount = 0;
  const conflicts = [];
  for (const row of parsed.rows) {
    let match = null;
    for (const c of row.codes) {
      const owner = codeIndex.get(c.norm);
      if (owner) { match = { itemId: owner, how: 'code', item: byId.get(owner) }; break; }
    }
    if (!match) {
      const key = `${row.brand.trim().toLowerCase()}|${row.model.trim().toLowerCase()}`;
      const owner = nameIndex.get(key);
      if (owner) match = { itemId: owner, how: 'name', item: byId.get(owner) };
    }
    // codes on this row that belong to a *different* existing part
    for (const c of row.codes) {
      const owner = codeIndex.get(c.norm);
      if (owner && (!match || owner !== match.itemId)) conflicts.push({ row: row.rowNo, code: c.code, owner: displayName(byId.get(owner)) });
    }
    row.match = match;
    if (match) existingCount++; else newCount++;
  }
  return { ...parsed, locations, newCount, existingCount, conflicts };
}

/**
 * Apply a preview. New parts are created with their codes and an 'import'
 * ledger row. Existing parts are skipped unless updateExisting is on.
 */
export async function applyImport(analysis, { updateExisting = false, fileName = '' } = {}) {
  const now = Date.now();
  const note = `Import ${fileName || ''}`.trim();
  const result = { created: 0, updated: 0, skipped: 0, codesAdded: 0, codesSkipped: 0 };

  await withTx(['items', 'barcodes', 'txns'], 'readwrite', async (t) => {
    const items = t.objectStore('items');
    const bc = t.objectStore('barcodes');
    const txns = t.objectStore('txns');

    for (const row of analysis.rows) {
      if (row.match) {
        if (!updateExisting) { result.skipped++; continue; }
        const item = await reqP(items.get(row.match.itemId));
        if (!item || item.deletedAt) { result.skipped++; continue; }
        let changed = false;
        if (row.type && !item.type) { item.type = row.type; changed = true; }
        if (row.locationId !== undefined && !row.locationUnknown && row.locationId !== (item.locationId ?? null)) {
          txns.add(ledgerRow(item, { type: 'move', delta: 0, qtyAfter: item.qty, note, source: 'import', fromLoc: item.locationId ?? null, toLoc: row.locationId, ts: now }));
          item.locationId = row.locationId; item.lastMovedAt = now; changed = true;
        }
        if (row.unit && row.unit !== item.unit) { item.unit = row.unit; changed = true; }
        const target = round3(row.qty);
        if (!row.flags.verify && target !== round3(item.qty)) {
          const d = round3(target - item.qty);
          item.qty = target; item.lastMovedAt = now;
          txns.add(ledgerRow(item, { type: 'import', delta: d, qtyAfter: target, note, source: 'import', ts: now }));
          changed = true;
        }
        for (const cls of row.codes) {
          const existing = await reqP(bc.get(cls.norm));
          if (existing && !existing.deletedAt && existing.itemId !== item.id) { result.codesSkipped++; continue; }
          if (existing && !existing.deletedAt) continue; // already linked here
          bc.put(makeCodeRec(cls, item.id, existing));
          result.codesAdded++;
        }
        if (changed) { item.updatedAt = now; items.put(item); result.updated++; } else result.skipped++;
        continue;
      }

      const base = normalizePart({
        brand: row.brand, model: row.model, type: row.type, unit: row.unit, min: row.min,
        locationId: row.locationId, notes: row.notes, flags: row.flags,
      });
      const qty = round3(row.qty);
      const item = { id: uuid(), ...base, qty, createdAt: now, updatedAt: now, lastMovedAt: qty ? now : null, lastCountedAt: null, deletedAt: null };
      for (const cls of row.codes) {
        const existing = await reqP(bc.get(cls.norm));
        if (existing && !existing.deletedAt) { result.codesSkipped++; continue; }
        bc.put(makeCodeRec(cls, item.id, existing));
        result.codesAdded++;
      }
      items.add(item);
      if (qty !== 0) txns.add(ledgerRow(item, { type: 'import', delta: qty, qtyAfter: qty, note, source: 'import', ts: now }));
      result.created++;
    }
  });

  await metaSet('lastImport', { fileName, at: now, ...result });
  if (!(await metaGet('firstTxnAt', null))) await metaSet('firstTxnAt', now);
  notifyDataChanged({ type: 'import' });
  return result;
}
