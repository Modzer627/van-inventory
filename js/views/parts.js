// Parts tab: search, filters, quick ±, new part.
import { applyStockChange } from '../db.js';
import { allParts, searchParts, isLow, displayName, distinctValues } from '../items.js';
import { codesByItem } from '../barcodes.js';
import { allLocations, locationMap, labelOf, RET_ID } from '../locations.js';
import { undoTxn } from '../txns.js';
import { esc, fmtQty, toast, debounce, pluralize } from '../ui.js';
import * as nav from '../nav.js';
import { openPartForm } from './sheets.js';

const section = () => document.getElementById('screen-parts');

const state = { q: '', filter: 'all', type: '', loc: '', sort: 'name' };
let changedHandler = null;

function applyFilters(items, codes, locMap) {
  let rows = searchParts(items, state.q, codes);
  if (state.filter === 'low') rows = rows.filter(isLow);
  if (state.filter === 'return') rows = rows.filter(i => i.locationId === RET_ID);
  if (state.filter === 'nocode') rows = rows.filter(i => !(codes.get(i.id) || []).length);
  if (state.filter === 'verify') rows = rows.filter(i => (i.flags && i.flags.verify) || i.qty < 0 || (codes.get(i.id) || []).some(c => c.flags && c.flags.precisionLost));
  if (state.type) rows = rows.filter(i => i.type === state.type);
  if (state.loc) rows = rows.filter(i => (state.loc === 'UNASSIGNED' ? !i.locationId : i.locationId === state.loc));
  if (state.sort === 'qty') rows = [...rows].sort((a, b) => a.qty - b.qty);
  else if (state.sort === 'moved') rows = [...rows].sort((a, b) => (b.lastMovedAt || 0) - (a.lastMovedAt || 0));
  else if (state.sort === 'shelf') {
    const sortOf = new Map([...locMap.values()].map(l => [l.id, l.sort]));
    rows = [...rows].sort((a, b) => ((a.locationId ? sortOf.get(a.locationId) ?? 950 : 990) - (b.locationId ? sortOf.get(b.locationId) ?? 950 : 990)));
  }
  return rows;
}

function rowHTML(i, codes, locMap) {
  const low = isLow(i);
  const loc = locMap.get(i.locationId);
  const noCode = !(codes.get(i.id) || []).length;
  return `
    <div class="item-row${low ? ' low' : ''}" data-id="${i.id}">
      <div class="item-main" data-open>
        <div class="item-name"><span class="brand">${esc(i.brand)}</span> ${esc(i.model)}${low ? ' · <span class="low-tag">LOW</span>' : ''}</div>
        <div class="item-sub">
          ${i.type ? `<span>${esc(i.type)}</span>` : ''}
          <span class="shelf-badge${i.locationId === RET_ID ? ' ret' : (!loc ? ' muted' : '')}">${esc(loc ? loc.code : '—')}</span>
          ${noCode ? '<span>no barcode</span>' : ''}
          ${i.flags && i.flags.verify ? '<span style="color:var(--warn-text)">verify</span>' : ''}
        </div>
      </div>
      <div class="item-qty" data-open><div class="q${i.qty < 0 ? ' neg' : ''}">${fmtQty(i.qty)}</div><div class="u">${esc(i.unit === 'ea' ? 'pcs' : i.unit)}</div></div>
      <div class="stepper">
        <button data-plus aria-label="Add one">+</button>
        <button data-minus aria-label="Remove one">−</button>
      </div>
    </div>`;
}

async function render() {
  const sec = section();
  const [items, codes, locs] = await Promise.all([allParts(), codesByItem(), allLocations()]);
  const locMap = locationMap(locs);
  const rows = applyFilters(items, codes, locMap);
  const lowCount = items.filter(isLow).length;
  const types = distinctValues(items, 'type');

  sec.innerHTML = `
    <header class="hdr">
      <h1>Parts<span class="sub">${pluralize(items.length, 'part')}${lowCount ? ` · <span style="color:var(--danger)">${lowCount} low</span>` : ''}</span></h1>
      <button class="icon-btn" data-settings aria-label="Settings">⚙️</button>
    </header>
    <div class="content">
      <div class="searchbar"><input type="search" data-q value="${esc(state.q)}" placeholder="Search brand, model, type, barcode" autocomplete="off" enterkeyhint="search"></div>
      <div class="filters">
        ${[['all', 'All'], ['low', 'Low'], ['return', 'Return pile'], ['nocode', 'No barcode'], ['verify', 'Verify']].map(([k, l]) =>
          `<button class="chip${state.filter === k ? ' on' : ''}" data-filter="${k}">${l}</button>`).join('')}
        <select data-type aria-label="Type"><option value="">Any type</option>${types.map(t => `<option value="${esc(t)}"${state.type === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select data-loc aria-label="Shelf"><option value="">Any shelf</option>${locs.map(l => `<option value="${esc(l.id)}"${state.loc === l.id ? ' selected' : ''}>${esc(labelOf(l, locMap))}</option>`).join('')}<option value="UNASSIGNED"${state.loc === 'UNASSIGNED' ? ' selected' : ''}>Unassigned</option></select>
        <select data-sort aria-label="Sort">
          <option value="name"${state.sort === 'name' ? ' selected' : ''}>A → Z</option>
          <option value="qty"${state.sort === 'qty' ? ' selected' : ''}>Fewest first</option>
          <option value="moved"${state.sort === 'moved' ? ' selected' : ''}>Recently moved</option>
          <option value="shelf"${state.sort === 'shelf' ? ' selected' : ''}>By shelf</option>
        </select>
      </div>
      ${rows.length ? rows.map(i => rowHTML(i, codes, locMap)).join('')
        : items.length ? '<div class="empty">No parts match these filters.</div>'
        : `<div class="empty"><span class="big">📦</span>No parts yet.<br>Import your spreadsheet from Settings, or tap + to add one.</div>`}
      ${rows.length ? `<div class="txn-sub" style="text-align:center;margin-top:6px">${pluralize(rows.length, 'part')} shown</div>` : ''}
    </div>
    <button class="fab" data-new aria-label="New part">＋</button>`;

  const q = sec.querySelector('[data-q]');
  q.addEventListener('input', debounce(() => { state.q = q.value; renderList(); }, 120));
  sec.querySelector('[data-settings]').addEventListener('click', () => nav.show('settings'));
  sec.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; render(); }));
  sec.querySelector('[data-type]').addEventListener('change', (e) => { state.type = e.target.value; render(); });
  sec.querySelector('[data-loc]').addEventListener('change', (e) => { state.loc = e.target.value; render(); });
  sec.querySelector('[data-sort]').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  sec.querySelector('[data-new]').addEventListener('click', () => openPartForm({ onSaved: (p) => { if (p) nav.show('part', { id: p.id }); } }));
  wireRows(sec);
}

/** Re-render only the list (keeps the search box focused). */
async function renderList() {
  const sec = section();
  const content = sec.querySelector('.content');
  if (!content) return;
  const [items, codes, locs] = await Promise.all([allParts(), codesByItem(), allLocations()]);
  const locMap = locationMap(locs);
  const rows = applyFilters(items, codes, locMap);
  content.querySelectorAll('.item-row, .empty, .txn-sub').forEach(el => el.remove());
  content.insertAdjacentHTML('beforeend', rows.length ? rows.map(i => rowHTML(i, codes, locMap)).join('') + `<div class="txn-sub" style="text-align:center;margin-top:6px">${pluralize(rows.length, 'part')} shown</div>` : '<div class="empty">No parts match.</div>');
  wireRows(sec);
}

function wireRows(sec) {
  sec.querySelectorAll('.item-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => nav.show('part', { id })));
    row.querySelector('[data-plus]').addEventListener('click', (e) => { e.stopPropagation(); quick(id, +1); });
    row.querySelector('[data-minus]').addEventListener('click', (e) => { e.stopPropagation(); quick(id, -1); });
  });
}

async function quick(id, dir) {
  try {
    const { item, txn } = await applyStockChange({ itemId: id, delta: dir, type: dir > 0 ? 'in' : 'out', source: 'manual' });
    toast(`${displayName(item)} ${dir > 0 ? '+1' : '−1'} → ${fmtQty(item.qty)} ${item.unit}`, {
      actionLabel: 'Undo', action: async () => { await undoTxn(txn.id); renderList(); }, duration: 3500,
    });
    renderList();
  } catch (e) {
    toast(e.message, { error: true });
  }
}

export default {
  async show(params = {}) {
    if (params.filter) { state.filter = params.filter; state.q = ''; state.type = ''; state.loc = ''; }
    await render();
    if (!changedHandler) {
      changedHandler = debounce(() => { if (nav.currentScreen() === 'parts') renderList(); }, 200);
      window.addEventListener('van:changed', changedHandler);
    }
  },
  refresh: render,
};
