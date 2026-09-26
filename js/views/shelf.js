// One location: what lives here, scan parts onto it, count it.
import { allParts, isLow, partCompare } from '../items.js';
import { allLocations, locationMap, labelOf, updateLocation, SIDE_LABEL, KIND_LABEL, RET_ID, UNASSIGNED_KEY, keyOf } from '../locations.js';
import { openCount, startCount, suggestLabel } from '../counts.js';
import { esc, fmtQty, toast, pluralize } from '../ui.js';
import * as nav from '../nav.js';
import { openTextSheet } from './sheets.js';

const section = () => document.getElementById('screen-shelf');
let currentKey = null;

async function render() {
  const sec = section();
  const [items, locs] = await Promise.all([allParts(), allLocations()]);
  const map = locationMap(locs);
  const isUnassigned = currentKey === UNASSIGNED_KEY;
  const loc = isUnassigned ? null : map.get(currentKey);
  if (!isUnassigned && !loc) { nav.back(); return; }
  const here = items.filter(i => keyOf(i) === currentKey).sort(partCompare);
  const children = locs.filter(l => l.parentId === currentKey);
  const low = here.filter(isLow).length;
  const name = isUnassigned ? 'Unassigned' : labelOf(loc, map);
  const subBits = [];
  if (loc) { if (SIDE_LABEL[loc.side] && loc.side !== 'none') subBits.push(SIDE_LABEL[loc.side]); if (loc.tag) subBits.push(`${loc.tag} shelf`); else if (KIND_LABEL[loc.kind]) subBits.push(KIND_LABEL[loc.kind]); }
  subBits.push(pluralize(here.length, 'part'));

  const groups = new Map();
  for (const i of here) { const k = i.type || 'OTHER'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>${esc(name)}<span class="sub">${esc(subBits.join(' · '))}</span></h1>
      ${loc ? '<button class="icon-btn" data-rename aria-label="Rename">✎</button>' : ''}
    </header>
    <div class="content">
      ${low ? `<div class="banner">${pluralize(low, 'part')} on this shelf ${low === 1 ? 'is' : 'are'} at or below minimum.</div>` : ''}
      ${isUnassigned && here.length ? '<div class="banner info">These parts have no shelf yet. Open one and tap the shelf button, or use “Scan parts onto this shelf” from the shelf they belong on.</div>' : ''}
      <div class="sheet-actions" style="margin:0 0 14px">
        ${currentKey === RET_ID ? '' : `<button class="btn btn-primary" data-scanmove>📷 Scan parts onto ${isUnassigned ? 'here' : 'this shelf'}</button>`}
        <button class="btn" data-count>✅ Count ${isUnassigned ? 'these' : 'this shelf'}</button>
      </div>
      ${children.length ? `<div class="section-title">Inside</div>${children.map(c => {
        const n = items.filter(i => i.locationId === c.id).length;
        return `<button class="loc-card" data-child="${esc(c.id)}"><div class="lc-name">${esc(c.name)}</div><div class="lc-n">${n}<small>${n === 1 ? 'part' : 'parts'}</small></div></button>`;
      }).join('')}` : ''}
      ${here.length ? [...groups.entries()].map(([type, list]) => `
        <div class="section-title">${esc(type)} <span class="txn-sub" style="text-transform:none;letter-spacing:0">${list.length}</span></div>
        ${list.map(i => `
          <div class="item-row${isLow(i) ? ' low' : ''}" data-id="${i.id}">
            <div class="item-main">
              <div class="item-name"><span class="brand">${esc(i.brand)}</span> ${esc(i.model)}${isLow(i) ? ' · <span class="low-tag">LOW</span>' : ''}</div>
              <div class="item-sub">${i.notes ? esc(i.notes) : (i.min ? `min ${fmtQty(i.min)}` : '')}</div>
            </div>
            <div class="item-qty"><div class="q${i.qty < 0 ? ' neg' : ''}">${fmtQty(i.qty)}</div><div class="u">${esc(i.unit === 'ea' ? 'pcs' : i.unit)}</div></div>
          </div>`).join('')}`).join('')
        : `<div class="empty"><span class="big">🗄️</span>Nothing filed here yet.</div>`}
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-rename]')?.addEventListener('click', () => openTextSheet({
    title: 'Rename location', label: 'Name', value: loc.name, okLabel: 'Save',
    onDone: async (v) => { if (v && v.trim()) { await updateLocation(loc.id, { name: v.trim() }); render(); } },
  }));
  sec.querySelector('[data-scanmove]')?.addEventListener('click', () => nav.show('scan', { move: currentKey }));
  sec.querySelector('[data-count]').addEventListener('click', async () => {
    if (await openCount()) { toast('A count is already in progress — finish or discard it first', { error: true, duration: 4000 }); nav.showTab('count'); return; }
    try {
      const label = `${await suggestLabel()} · ${name}`;
      await startCount({ label, scope: { locationIds: [currentKey] }, includeReturn: currentKey === RET_ID });
      nav.showTab('count');
    } catch (e) { toast(e.message, { error: true }); }
  });
  sec.querySelectorAll('[data-child]').forEach(b => b.addEventListener('click', () => { currentKey = b.dataset.child; render(); }));
  sec.querySelectorAll('[data-id]').forEach(r => r.addEventListener('click', () => nav.show('part', { id: r.dataset.id })));
}

export default {
  show(params) {
    currentKey = params.id;
    return render();
  },
  refresh: render,
};
