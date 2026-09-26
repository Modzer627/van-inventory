// Runs the app's own spreadsheet parser over a real file and prints the preview
// counts — the same numbers the in-app preview shows.
//   node tools/import-check.mjs "C:/path/to/Van Inventory.xlsx"
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseGrid, makeShelfResolver, parseCsv } from '../js/import-parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const XLSX = require(path.join(here, '..', 'vendor', 'sheetjs', 'xlsx.full.min.js'));

const file = process.argv[2];
if (!file) { console.error('usage: node tools/import-check.mjs <file.xlsx|csv>'); process.exit(2); }

let grid;
if (/\.csv$/i.test(file)) {
  grid = parseCsv(readFileSync(file, 'utf8'));
} else {
  const wb = XLSX.read(readFileSync(file), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}

const seedLocations = [
  { id: 'S1', code: '1', name: 'Shelf 1' }, { id: 'S2', code: '2', name: 'Shelf 2' }, { id: 'S3', code: '3', name: 'Shelf 3' },
  { id: 'F3', code: '3F', name: 'Floor under 3' }, { id: 'S4', code: '4', name: 'Shelf 4' }, { id: 'S5', code: '5', name: 'Shelf 5' },
  { id: 'S6', code: '6', name: 'Shelf 6' }, { id: 'S7', code: '7', name: 'Shelf 7' }, { id: 'S8', code: '8', name: 'Shelf 8' },
  { id: 'S9', code: '9', name: 'Shelf 9' }, { id: 'D9-1', code: '9-1', name: 'Drawer 1' }, { id: 'D9-2', code: '9-2', name: 'Drawer 2' },
  { id: 'D9-3', code: '9-3', name: 'Drawer 3' }, { id: 'RET', code: 'RET', name: 'Return pile' },
];

const { rows, report } = parseGrid(grid, { resolveShelf: makeShelfResolver(seedLocations), fileName: path.basename(file) });

const byLoc = {};
for (const r of rows) { const k = r.locationId || 'UNASSIGNED'; byLoc[k] = (byLoc[k] || 0) + 1; }
const primary = rows.filter(r => r.codes.some(c => c.role === 'primary')).length;

console.log('file           :', report.fileName, '(header row', report.headerRow + ')');
console.log('columns mapped :', report.mapped.join(', '), '| extras columns:', report.extrasCols);
console.log('parts          :', rows.length, '| skipped blank rows:', report.skippedBlank, '| no model:', report.skippedNoModel);
console.log('primary codes  :', primary, '| without a code:', report.codeStats.none, '| aliases from extras:', report.aliasCount);
console.log('code kinds     :', JSON.stringify(report.codeStats));
console.log('ft parts       :', report.ftCount, '| verify flags:', report.verifyCount, '| typed:', report.typeCount);
console.log('shelf values   :', JSON.stringify(report.shelfValues));
console.log('by location    :', JSON.stringify(byLoc));
console.log('unknown shelves:', JSON.stringify(report.unknownShelves), '| duplicate codes:', JSON.stringify(report.duplicateCodes));
const warned = rows.filter(r => r.warnings.length);
console.log('rows w/warnings:', warned.length);
for (const r of warned) console.log('   row', r.rowNo, r.brand, r.model, '→', r.warnings.join('; '));
const fixed = rows.flatMap(r => r.codes.filter(c => c.flags.fixedLeadingZero).map(c => `${r.brand} ${r.model}: ${c.code} (norm ${c.norm})`));
console.log('leading zero repaired:', fixed.join(' | ') || 'none');
const ft = rows.filter(r => r.unit === 'ft').map(r => `${r.model.slice(0, 22)}=${r.qty}`);
console.log('ft reels       :', ft.join(', '));
