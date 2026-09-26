// Locations manager: rename, reorder, add, merge, sides.
import { allParts } from '../items.js';
import { allLocations, locationMap, tree, bySide, statsByLocation, updateLocation, addLocation, reorderLocation, mergeLocations, labelOf, SIDE_LABEL, RET_ID } from '../locations.js';
import { esc, toast, confirmDialog, sheet } from '../ui.js';
import * as nav from '../nav.js';
import { openLocationPicker } from './sheets.js';

const section = () => document.getElementById('screen-locations');

function row(node, stats, child = false) {
  const l = node.loc;
  const s = stats.get(l.id) || { count: 0 };
  return `
    <div class="set-row" data-loc="${esc(l.id)}" style="${child ? 'padding-left:32px' : ''}">
      <div class="grow">${esc(l.name)} <span class="shelf-badge${l.id === RET_ID ? ' ret' : ''}">${esc(l.code)}</span>${l.tag ? ` <span class="lc-tag">${esc(l.tag)}</span>` : ''}
        <span class="hint">${s.count} part${s.count === 1 ? '' : 's'}${l.parentId ? '' : ` · ${SIDE_LABEL[l.side] || ''}`}</span></div>
      ${child || l.id === RET_ID ? '' : `<button class="icon-btn" data-up aria-label="Move up" style="width:38px;height:38px;font-size:15px">▲</button><button class="icon-btn" data-down aria-label="Move down" style="width:38px;height:38px;font-size:15px">▼</button>`}
      <button class="icon-btn" data-edit aria-label="Edit" style="width:38px;height:38px;font-size:15px">✎</button>
    </div>
    ${node.children.map(c => row(c, stats, true)).join('')}`;
}

async function render() {
  const sec = section();
  const [locs, items] = await Promise.all([allLocations(), allParts()]);
  const stats = statsByLocation(items);
  const sides = bySide(tree(locs));

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Shelves &amp; locations<span class="sub">rename · reorder · merge</span></h1>
      <button class="icon-btn" data-add aria-label="Add location">＋</button>
    </header>
    <div class="content">
      ${['left', 'right', 'none'].map(side => sides[side].length ? `
        <div class="section-title">${SIDE_LABEL[side]}</div>
        <div class="set-group">${sides[side].map(n => row(n, stats)).join('')}</div>` : '').join('')}
      <p class="txn-sub" style="line-height:1.6;margin-top:8px">Drawers and the floor spot are listed under the shelf they belong to. Merging a location moves every part on it to the one you pick and retires it.</p>
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-add]').addEventListener('click', () => openLocationForm(null, locs));
  sec.querySelectorAll('[data-loc]').forEach(r => {
    const id = r.dataset.loc;
    const loc = locs.find(l => l.id === id);
    r.querySelector('[data-up]')?.addEventListener('click', async () => { await reorderLocation(id, -1); render(); });
    r.querySelector('[data-down]')?.addEventListener('click', async () => { await reorderLocation(id, 1); render(); });
    r.querySelector('[data-edit]').addEventListener('click', () => openLocationForm(loc, locs));
  });
}

function openLocationForm(loc, locs) {
  const editing = !!loc;
  const parents = locs.filter(l => !l.parentId && l.id !== RET_ID && (!loc || l.id !== loc.id));
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field-row">
      <div class="field" style="flex:2"><label>Name</label><input type="text" data-name value="${esc(loc ? loc.name : '')}" placeholder="Shelf 10" autocomplete="off"></div>
      <div class="field"><label>Short code</label><input type="text" data-code value="${esc(loc ? loc.code : '')}" placeholder="10" autocomplete="off"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Side</label>
        <select data-side>${['left', 'right', 'none'].map(s => `<option value="${s}"${(loc ? loc.side : 'left') === s ? ' selected' : ''}>${SIDE_LABEL[s]}</option>`).join('')}</select></div>
      <div class="field"><label>Kind</label>
        <select data-kind>${[['shelf', 'Shelf'], ['drawer', 'Drawer'], ['floor', 'Floor spot'], ['pile', 'Pile (not stock)']].map(([k, l]) => `<option value="${k}"${(loc ? loc.kind : 'shelf') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Inside (optional)</label>
      <select data-parent><option value="">— top level —</option>${parents.map(p => `<option value="${esc(p.id)}"${loc && loc.parentId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="set-row" style="padding:0;border:none;min-height:0;cursor:pointer"><span class="grow">Bottom shelf tag</span><span class="switch"><input type="checkbox" data-bottom ${loc && loc.tag === 'bottom' ? 'checked' : ''}><span></span></span></label></div>
    <div class="sheet-actions">
      <button class="btn" data-cancel>Cancel</button>
      <button class="btn btn-primary" data-ok>${editing ? 'Save' : 'Add'}</button>
    </div>
    ${editing && loc.id !== RET_ID ? '<button class="btn btn-block" data-merge style="margin-top:12px;color:var(--danger)">Merge into another location…</button>' : ''}`;
  const s = sheet({ title: editing ? 'Edit location' : 'New location', content: wrap });
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', async () => {
    const name = wrap.querySelector('[data-name]').value.trim();
    const code = wrap.querySelector('[data-code]').value.trim();
    const side = wrap.querySelector('[data-side]').value;
    const kind = wrap.querySelector('[data-kind]').value;
    const parentId = wrap.querySelector('[data-parent]').value || null;
    const tag = wrap.querySelector('[data-bottom]').checked ? 'bottom' : null;
    if (!name) { toast('Name is required', { error: true }); return; }
    try {
      if (editing) await updateLocation(loc.id, { name, code: code || loc.code, side, kind, parentId, tag, usable: kind !== 'pile' });
      else await addLocation({ name, code, side, kind, parentId });
      s.close();
      render();
    } catch (e) { toast(e.message, { error: true }); }
  });
  wrap.querySelector('[data-merge]')?.addEventListener('click', () => {
    s.close();
    openLocationPicker({
      title: `Move everything on ${loc.name} to`, current: null,
      onPicked: async (target) => {
        if (target === undefined || target === loc.id) return;
        const map = locationMap(locs);
        const yes = await confirmDialog(`Move every part on ${loc.name} to ${labelOf(target, map)} and retire ${loc.name}?`, { danger: true, okLabel: 'Merge' });
        if (!yes) return;
        const n = await mergeLocations(loc.id, target);
        toast(`${n} part${n === 1 ? '' : 's'} moved · ${loc.name} retired`);
        render();
      },
    });
  });
}

export default { show: render, refresh: render };
