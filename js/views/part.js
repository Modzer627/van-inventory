// Part detail: stock actions, shelf, codes, history, delete.
import { applyStockChange, metaSet } from '../db.js';
import { getPart, deletePart, isLow, displayName, updatePart } from '../items.js';
import { codesOf, linkCode, unlinkCode } from '../barcodes.js';
import { allLocations, locationMap, labelOf, moveItem, RET_ID } from '../locations.js';
import { itemHistory, undoTxn, TYPE_LABEL, TYPE_ICON } from '../txns.js';
import { kindLabel } from '../codes.js';
import { esc, fmtQty, fmtDateTime, fmtDate, toast, confirmDialog, agoLabel } from '../ui.js';
import * as nav from '../nav.js';
import { openAmountSheet, openPartForm, openQtySheet, openLocationPicker, openTextSheet, offerRelink } from './sheets.js';

const section = () => document.getElementById('screen-part');
let currentId = null;

function txnRow(t, locMap) {
  const pos = t.delta > 0;
  const bits = [];
  if (t.type === 'move') bits.push(`${esc(labelOf(t.fromLoc, locMap))} → ${esc(labelOf(t.toLoc, locMap))}`);
  if (t.jobRef) bits.push(`Job: ${esc(t.jobRef)}`);
  if (t.note) bits.push(esc(t.note));
  return `
    <div class="txn-row" data-txn="${t.id}">
      <div class="txn-ico ${t.type}">${TYPE_ICON[t.type] || '·'}</div>
      <div class="txn-main">
        <div>${TYPE_LABEL[t.type] || t.type}${t.source === 'scan' ? ' <span class="txn-sub">· scan</span>' : ''}</div>
        <div class="txn-sub">${fmtDateTime(t.ts)}${bits.length ? ' · ' + bits.join(' · ') : ''}</div>
      </div>
      ${t.type === 'move' ? '' : `<div class="txn-delta ${pos ? 'pos' : t.delta < 0 ? 'neg' : ''}">${pos ? '+' : ''}${fmtQty(t.delta)}<div class="txn-sub" style="text-align:right">→ ${fmtQty(t.qtyAfter)}</div></div>`}
    </div>`;
}

async function render() {
  const sec = section();
  const item = await getPart(currentId);
  if (!item) { nav.back(); return; }
  const [codes, history, locs] = await Promise.all([codesOf(item.id), itemHistory(item.id, 60), allLocations()]);
  const locMap = locationMap(locs);
  const low = isLow(item);
  const loc = locMap.get(item.locationId);

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>${esc(displayName(item))}<span class="sub">${esc(item.type || 'Part')}${item.deletedAt ? ' · deleted' : ''}</span></h1>
      <button class="icon-btn" data-edit aria-label="Edit">✎</button>
    </header>
    <div class="content">
      ${item.deletedAt ? `<div class="banner bad">This part is deleted. <button class="btn btn-sm" data-restore>Restore</button></div>` : ''}
      <div class="item-row${low ? ' low' : ''}" style="margin-bottom:12px">
        <div class="item-main">
          <div class="item-name">On the van${low ? ' · <span class="low-tag">LOW</span>' : ''}</div>
          <div class="item-sub">${item.min ? `Alert at ≤ ${fmtQty(item.min)}` : 'No minimum set'}${item.lastCountedAt ? ` · counted ${agoLabel(item.lastCountedAt)}` : ''}</div>
        </div>
        <div class="item-qty"><div class="q${item.qty < 0 ? ' neg' : ''}" style="font-size:28px">${fmtQty(item.qty)}</div><div class="u">${esc(item.unit === 'ea' ? 'pcs' : item.unit)}</div></div>
      </div>
      <button class="btn btn-block" data-move style="margin-bottom:12px;justify-content:space-between">
        <span>Shelf</span>
        <span class="shelf-badge lg${item.locationId === RET_ID ? ' ret' : (!loc ? ' muted' : '')}">${esc(labelOf(item.locationId, locMap))}</span>
      </button>
      ${item.qty < 0 ? '<div class="banner bad">Quantity is below zero — set the real count.</div>' : ''}
      ${item.flags && item.flags.verify ? '<div class="banner">The amount in the spreadsheet was unclear — check the shelf and set the count. <button class="btn btn-sm" data-verified>Verified</button></div>' : ''}

      <div class="sheet-actions" style="margin:0 0 16px">
        <button class="btn" data-in>＋ Add</button>
        <button class="btn" data-out>− Remove</button>
        <button class="btn" data-set>Set qty</button>
      </div>

      <div class="kv">
        <div class="row"><b>Brand</b><span class="grow">${esc(item.brand || '—')}</span></div>
        <div class="row"><b>Model</b><span class="grow">${esc(item.model)}</span></div>
        <div class="row"><b>Type</b><span class="grow">${esc(item.type || '—')}</span></div>
        <div class="row"><b>Unit</b><span class="grow">${item.unit === 'ft' ? 'feet' : 'pieces'}</span></div>
        <div class="row"><b>Min</b><span class="grow">${item.min ? fmtQty(item.min) : '—'}</span><button class="btn btn-sm" data-min>Change</button></div>
        ${item.notes ? `<div class="row"><b>Notes</b><span class="grow">${esc(item.notes)}</span></div>` : ''}
        <div class="row"><b>Moved</b><span class="grow">${item.lastMovedAt ? fmtDate(item.lastMovedAt) : '—'}</span></div>
      </div>

      <div class="section-title">Barcodes <span class="grow"></span><button class="btn btn-sm" data-addcode>Type one</button><button class="btn btn-sm btn-primary" data-scancode>Scan one</button></div>
      <div class="code-list" style="margin-bottom:6px">
        ${codes.length ? codes.map(c => `
          <div class="code-row">
            <span class="kind">${esc(kindLabel(c.kind))}</span>
            <span class="code">${esc(c.code)}${c.flags && c.flags.precisionLost ? ' <span class="warn">lost digits in Excel — re-scan</span>' : ''}${c.flags && c.flags.fixedLeadingZero ? ' <span class="warn">leading zero restored</span>' : ''}</span>
            <button data-unlink="${esc(c.norm)}" aria-label="Remove code">✕</button>
          </div>`).join('') : '<div class="txn-sub">No barcode linked yet. Scan the box label with “Scan one”.</div>'}
      </div>

      ${item.locationId !== RET_ID ? `<button class="btn btn-block" data-toreturn style="margin-top:14px">↩ Move to the Return pile</button>` : `<button class="btn btn-block" data-returned style="margin-top:14px">✓ Returned — remove from the van</button>`}

      <div class="section-title">History</div>
      ${history.length ? history.map(t => txnRow(t, locMap)).join('') : '<div class="empty">No movements yet.</div>'}

      ${item.deletedAt ? '' : '<button class="btn btn-block" data-delete style="margin-top:22px;color:var(--danger)">Delete part</button>'}
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-edit]').addEventListener('click', () => openPartForm({ item, onSaved: (u) => { if (u) render(); } }));
  sec.querySelector('[data-restore]')?.addEventListener('click', async () => {
    const { restorePart } = await import('../items.js');
    await restorePart(item.id); toast('Restored'); render();
  });
  sec.querySelector('[data-verified]')?.addEventListener('click', async () => {
    await updatePart(item.id, { flags: { ...item.flags, verify: false } }); render();
  });
  sec.querySelector('[data-move]').addEventListener('click', () => openLocationPicker({
    title: `Move ${displayName(item)} to`, current: item.locationId,
    onPicked: async (locId) => {
      if (locId === undefined || (locId || null) === (item.locationId || null)) return;
      await moveItem(item.id, locId, { source: 'manual' });
      if (locId) await metaSet('lastLocationId', locId);
      toast(`Moved to ${labelOf(locId, locMap)}`);
      render();
    },
  }));
  sec.querySelector('[data-in]').addEventListener('click', () => openAmountSheet({
    item, mode: 'add', initial: item.unit === 'ft' ? 25 : 1,
    onDone: async (v) => {
      if (!v) return;
      const { item: u } = await applyStockChange({ itemId: item.id, delta: v.qty, type: 'in', note: v.note || null, source: 'manual' });
      toast(`+${fmtQty(v.qty)} → now ${fmtQty(u.qty)} ${u.unit}`); render();
    },
  }));
  sec.querySelector('[data-out]').addEventListener('click', () => openAmountSheet({
    item, mode: 'remove', initial: item.unit === 'ft' ? 25 : 1,
    onDone: async (v) => {
      if (!v) return;
      const { item: u } = await applyStockChange({ itemId: item.id, delta: -v.qty, type: 'out', jobRef: v.jobRef || null, note: v.note || null, source: 'manual' });
      if (v.jobRef) (await import('../txns.js')).pushJob(v.jobRef);
      toast(`−${fmtQty(v.qty)} → now ${fmtQty(u.qty)} ${u.unit}`);
      if (u.qty < 0) toast(`${displayName(u)} is below zero — set the real count`, { error: true, duration: 4000 });
      render();
    },
  }));
  sec.querySelector('[data-set]').addEventListener('click', () => openQtySheet({
    title: `Set quantity — <span class="sheet-item-name">${esc(displayName(item))}</span>`, okLabel: 'Set',
    initial: Math.max(0, item.qty), unit: item.unit, allowZero: true,
    onDone: async (qty) => {
      if (qty === null) return;
      if (qty === item.qty) return;
      await applyStockChange({ itemId: item.id, to: qty, type: 'set', note: 'Set on the part page', source: 'manual' });
      toast(`Quantity set to ${fmtQty(qty)} ${item.unit}`); render();
    },
  }));
  sec.querySelector('[data-min]').addEventListener('click', () => openQtySheet({
    title: 'Alert when stock drops to', okLabel: 'Save', initial: item.min || 0, unit: item.unit, allowZero: true,
    onDone: async (qty) => { if (qty === null) return; await updatePart(item.id, { min: qty || null }); render(); },
  }));
  sec.querySelector('[data-addcode]').addEventListener('click', () => openTextSheet({
    title: 'Add a barcode', label: 'Code', placeholder: 'Type or paste the code', okLabel: 'Link',
    onDone: async (text) => { if (text) await tryLink(item, text, 'manual'); },
  }));
  sec.querySelector('[data-scancode]').addEventListener('click', () => nav.show('scan', { link: item.id }));
  sec.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', async () => {
    const yes = await confirmDialog('Remove this barcode from the part? A future scan of it will ask to add a new part.', { okLabel: 'Remove', danger: true });
    if (!yes) return;
    await unlinkCode(b.dataset.unlink); render();
  }));
  sec.querySelector('[data-toreturn]')?.addEventListener('click', async () => {
    await moveItem(item.id, RET_ID, { source: 'manual', note: 'To return' });
    toast('In the Return pile'); render();
  });
  sec.querySelector('[data-returned]')?.addEventListener('click', async () => {
    const yes = await confirmDialog(`Mark ${displayName(item)} as returned? Its quantity goes to 0 and it leaves the Return pile.`, { okLabel: 'Returned' });
    if (!yes) return;
    if (item.qty !== 0) await applyStockChange({ itemId: item.id, to: 0, type: 'out', note: 'Returned to the office', source: 'manual' });
    await moveItem(item.id, null, { source: 'manual', note: 'Returned' });
    toast('Returned'); render();
  });
  sec.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const yes = await confirmDialog(`Delete "${displayName(item)}"? Its history is kept and you can restore it from Settings.`, { danger: true, okLabel: 'Delete' });
    if (!yes) return;
    await deletePart(item.id);
    toast(`Deleted ${displayName(item)}`);
    nav.back();
  });
  sec.querySelectorAll('[data-txn]').forEach(row => row.addEventListener('click', async () => {
    const id = row.dataset.txn;
    const t = history.find(x => x.id === id);
    if (!t) return;
    const yes = await confirmDialog(`Undo this movement (${TYPE_LABEL[t.type] || t.type}${t.type === 'move' ? '' : ` ${t.delta > 0 ? '+' : ''}${fmtQty(t.delta)}`})?`, { okLabel: 'Undo' });
    if (!yes) return;
    try { await undoTxn(id); toast('Undone'); render(); } catch (e) { toast(e.message, { error: true }); }
  }));
}

export async function tryLink(item, raw, format) {
  try {
    await linkCode(item.id, raw, format);
    toast('Barcode linked');
  } catch (e) {
    const { ConflictError } = await import('../items.js');
    if (e instanceof ConflictError) {
      if (await offerRelink(e, item)) toast('Barcode moved to this part');
    } else toast(e.message, { error: true });
  }
  render();
}

export default {
  show(params) {
    currentId = params.id;
    return render();
  },
  refresh: render,
};
