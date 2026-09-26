// Shared bottom-sheet flows: quantity entry, remove/add with job, part form,
// unknown-code choice, part picker, location picker, text prompt.
import { metaSet } from '../db.js';
import { createPart, updatePart, allParts, distinctValues, displayName, ConflictError, partCompare } from '../items.js';
import { codesOf, codesByItem, relinkCode } from '../barcodes.js';
import { allLocations, locationMap, labelOf, tree, bySide, SIDE_LABEL, RET_ID } from '../locations.js';
import { recentJobs } from '../txns.js';
import { classifyCode, kindLabel, formatLabel } from '../codes.js';
import { sheet, toast, esc, fmtQty, confirmDialog } from '../ui.js';

/* ---------- stepper ---------- */
export function stepperHTML(initial = 1, { unit = '' } = {}) {
  return `
    <div class="qty-stepper">
      <button type="button" data-step="-1" aria-label="Less">−</button>
      <input type="text" inputmode="decimal" value="${esc(fmtQty(initial))}" data-qty>
      <button type="button" data-step="1" aria-label="More">+</button>
    </div>
    ${unit ? `<div class="qty-unit">${esc(unit === 'ea' ? 'pieces' : unit)}</div>` : ''}`;
}

export function wireStepper(root, { min = 0, step = 1 } = {}) {
  const input = root.querySelector('[data-qty]');
  root.querySelectorAll('[data-step]').forEach(b => {
    b.addEventListener('click', () => {
      const cur = parseFloat(input.value.replace(',', '.')) || 0;
      const next = Math.max(min, Math.round((cur + Number(b.dataset.step) * step) * 1000) / 1000);
      input.value = fmtQty(next);
    });
  });
  input.addEventListener('focus', () => input.select());
  return () => Math.round((parseFloat(input.value.replace(',', '.')) || 0) * 1000) / 1000;
}

function chipsHTML(values, current) {
  return `<div class="chips" style="justify-content:center">${values.map(v =>
    `<button type="button" class="chip${Number(v) === Number(current) ? ' on' : ''}" data-chipval="${v}">${fmtQty(v)}</button>`).join('')}</div>`;
}
function wireChips(root) {
  const input = root.querySelector('[data-qty]');
  root.querySelectorAll('[data-chipval]').forEach(c => c.addEventListener('click', () => {
    input.value = fmtQty(c.dataset.chipval);
    root.querySelectorAll('[data-chipval]').forEach(x => x.classList.toggle('on', x === c));
  }));
}

/** Generic quantity sheet. onDone(qty) (qty ≥ min) or null when cancelled. */
export function openQtySheet({ title, okLabel = 'Save', initial = 1, unit = '', chips = null, min = 0, allowZero = false, onDone }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${stepperHTML(initial, { unit })}
    ${chips ? chipsHTML(chips, initial) : ''}
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>${esc(okLabel)}</button>
    </div>`;
  const s = sheet({ title, content: wrap, onClose: () => onDone && onDone(null) });
  const getQty = wireStepper(wrap, { min, step: unit === 'ft' ? 5 : 1 });
  if (chips) wireChips(wrap);
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', () => {
    const qty = getQty();
    if (!allowZero && !(qty > 0)) { toast('Enter a quantity', { error: true }); return; }
    const cb = onDone; onDone = null;
    s.close();
    if (cb) cb(qty);
  });
  setTimeout(() => wrap.querySelector('[data-qty]').focus({ preventScroll: true }), 80);
  return s;
}

/**
 * Remove/Add amount with optional job + note. onDone({qty, jobRef, note}) or null.
 */
export async function openAmountSheet({ item, mode = 'remove', initial = 1, onDone }) {
  const jobs = mode === 'remove' ? await recentJobs() : [];
  const chips = item.unit === 'ft' ? [10, 25, 50, 100] : null;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${stepperHTML(initial, { unit: item.unit })}
    ${chips ? chipsHTML(chips, initial) : ''}
    ${mode === 'remove' ? `
    <div class="field">
      <label>Job / customer (optional)</label>
      <input type="text" data-job placeholder="Where did it go?" autocomplete="off">
      ${jobs.length ? `<div class="chips">${jobs.map(j => `<button type="button" class="chip" data-jobchip>${esc(j)}</button>`).join('')}</div>` : ''}
    </div>` : ''}
    <div class="field">
      <label>Note (optional)</label>
      <input type="text" data-note autocomplete="off">
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>${mode === 'remove' ? 'Remove' : 'Add'}</button>
    </div>`;
  const s = sheet({
    title: `${mode === 'remove' ? 'Remove' : 'Add'} — <span class="sheet-item-name">${esc(displayName(item))} (${fmtQty(item.qty)} ${esc(item.unit)})</span>`,
    content: wrap, onClose: () => onDone && onDone(null),
  });
  const getQty = wireStepper(wrap, { step: item.unit === 'ft' ? 5 : 1 });
  if (chips) wireChips(wrap);
  const jobInput = wrap.querySelector('[data-job]');
  wrap.querySelectorAll('[data-jobchip]').forEach(c => c.addEventListener('click', () => { jobInput.value = c.textContent; }));
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', () => {
    const qty = getQty();
    if (!(qty > 0)) { toast('Enter a quantity', { error: true }); return; }
    const cb = onDone; onDone = null;
    s.close();
    if (cb) cb({ qty, jobRef: jobInput ? jobInput.value.trim() : '', note: wrap.querySelector('[data-note]').value.trim() });
  });
  setTimeout(() => wrap.querySelector('[data-qty]').focus({ preventScroll: true }), 80);
}

/* ---------- location options ---------- */
async function locationOptionsHTML(current) {
  const locs = await allLocations();
  const map = locationMap(locs);
  const opts = [`<option value=""${!current ? ' selected' : ''}>Unassigned</option>`];
  for (const l of locs) opts.push(`<option value="${esc(l.id)}"${l.id === current ? ' selected' : ''}>${esc(labelOf(l, map))}</option>`);
  return opts.join('');
}

/**
 * Part form. Create (prefill.codes = [{code, format}] | ['raw']) or edit (item).
 * onSaved(part|null). Quantity and location changes on existing parts go through the ledger elsewhere.
 */
export async function openPartForm({ item = null, prefill = {}, onSaved = null } = {}) {
  const editing = !!item;
  const v = (f, d = '') => esc(editing ? (item[f] ?? d) : (prefill[f] ?? d));
  const items = await allParts();
  const brands = distinctValues(items, 'brand');
  const types = distinctValues(items, 'type');
  const unit = editing ? (item.unit || 'ea') : (prefill.unit || 'ea');
  const codes = editing ? await codesOf(item.id) : (prefill.codes || []).map(c => (typeof c === 'string' ? { code: c, format: null } : c)).map(c => classifyCode(c.code, c.format)).filter(Boolean);
  const locOpts = await locationOptionsHTML(editing ? item.locationId : (prefill.locationId ?? null));

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field-row">
      <div class="field">
        <label>Brand</label>
        <input type="text" data-f="brand" value="${v('brand')}" list="dl-brands" autocomplete="off" autocapitalize="characters" placeholder="DMP, Resideo…">
        <datalist id="dl-brands">${brands.map(b => `<option value="${esc(b)}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label>Model / part no. *</label>
        <input type="text" data-f="model" value="${v('model')}" autocomplete="off" autocapitalize="characters" placeholder="1164-W">
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Type</label>
        <input type="text" data-f="type" value="${v('type')}" list="dl-types" autocomplete="off" autocapitalize="characters" placeholder="SMOKE, CONTACT…">
        <datalist id="dl-types">${types.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label>Counted in</label>
        <div class="seg-page" data-unit-seg>
          <button type="button" data-unit="ea" class="${unit === 'ea' ? 'on' : ''}">pieces</button>
          <button type="button" data-unit="ft" class="${unit === 'ft' ? 'on' : ''}">feet</button>
        </div>
      </div>
    </div>
    <div class="field-row">
      ${editing ? '' : `
      <div class="field">
        <label>Quantity on the van</label>
        <input type="text" data-f="qty" value="${esc(fmtQty(prefill.qty ?? 0))}" inputmode="decimal">
      </div>`}
      <div class="field">
        <label>Min stock (alert at)</label>
        <input type="text" data-f="min" value="${editing ? esc(item.min ?? '') : esc(prefill.min ?? '')}" inputmode="decimal" placeholder="none">
      </div>
    </div>
    <div class="field">
      <label>Shelf</label>
      <select data-f="locationId">${locOpts}</select>
    </div>
    <div class="field">
      <label>Barcodes</label>
      <div class="code-list" data-codes></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" data-newcode placeholder="Type or paste another code" autocomplete="off" style="flex:1;min-height:44px;padding:8px 12px;border-radius:11px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:15px">
        <button type="button" class="btn btn-sm" data-addcode>Add</button>
      </div>
    </div>
    <div class="field">
      <label>Notes</label>
      <textarea data-f="notes">${v('notes')}</textarea>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>${editing ? 'Save changes' : 'Add part'}</button>
    </div>`;

  const s = sheet({ title: editing ? 'Edit part' : 'New part', content: wrap, onClose: () => onSaved && onSaved(null) });
  let curUnit = unit;
  wrap.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
    curUnit = b.dataset.unit;
    wrap.querySelectorAll('[data-unit]').forEach(x => x.classList.toggle('on', x === b));
  }));

  const pendingCodes = [...codes]; // create: classified; edit: records (norm/code/kind)
  const removedNorms = new Set();
  const renderCodes = () => {
    const box = wrap.querySelector('[data-codes]');
    const live = pendingCodes.filter(c => !removedNorms.has(c.norm));
    box.innerHTML = live.length ? live.map(c => `
      <div class="code-row">
        <span class="kind">${esc(kindLabel(c.kind))}</span>
        <span class="code">${esc(c.code)}${c.flags && c.flags.precisionLost ? ' <span class="warn">lost digits</span>' : ''}</span>
        <button type="button" data-rmcode="${esc(c.norm)}" aria-label="Remove code">✕</button>
      </div>`).join('') : '<div class="txn-sub">No barcode yet — scan one later from the part page.</div>';
    box.querySelectorAll('[data-rmcode]').forEach(b => b.addEventListener('click', () => { removedNorms.add(b.dataset.rmcode); renderCodes(); }));
  };
  renderCodes();
  const newCodeInput = wrap.querySelector('[data-newcode]');
  const addTyped = () => {
    const cls = classifyCode(newCodeInput.value, 'manual');
    if (!cls) return;
    if (pendingCodes.some(c => c.norm === cls.norm && !removedNorms.has(c.norm))) { toast('Already on the list'); return; }
    removedNorms.delete(cls.norm);
    pendingCodes.push(cls);
    newCodeInput.value = '';
    renderCodes();
  };
  wrap.querySelector('[data-addcode]').addEventListener('click', addTyped);
  newCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });

  const read = () => {
    const out = {};
    wrap.querySelectorAll('[data-f]').forEach(i => { out[i.dataset.f] = i.value; });
    out.unit = curUnit;
    out.locationId = out.locationId || null;
    return out;
  };

  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', async () => {
    const data = read();
    if (!data.model.trim()) { toast('Model / part number is required', { error: true }); return; }
    try {
      let saved;
      if (editing) {
        const patch = { brand: data.brand, model: data.model, type: data.type, unit: data.unit, min: data.min, notes: data.notes };
        saved = await updatePart(item.id, patch);
        const { linkCode, unlinkCode } = await import('../barcodes.js');
        for (const n of removedNorms) if (codes.some(c => c.norm === n)) await unlinkCode(n);
        for (const c of pendingCodes) if (!codes.some(x => x.norm === c.norm) && !removedNorms.has(c.norm)) {
          try { await linkCode(item.id, c.raw || c.code, c.format); }
          catch (e) { toast(e.message, { error: true, duration: 4000 }); }
        }
        if ((data.locationId || null) !== (item.locationId || null)) {
          const { moveItem } = await import('../locations.js');
          await moveItem(item.id, data.locationId, { note: 'Edited', source: 'manual' });
          if (data.locationId) await metaSet('lastLocationId', data.locationId);
        }
      } else {
        saved = await createPart({
          ...data, codes: pendingCodes.filter(c => !removedNorms.has(c.norm)).map(c => ({ code: c.raw || c.code, format: c.format })),
          source: 'manual', note: 'Added on the phone',
        });
        if (data.locationId) await metaSet('lastLocationId', data.locationId);
      }
      const cb = onSaved; onSaved = null;
      s.close();
      toast(editing ? 'Saved' : `Added ${displayName(saved)}`);
      if (cb) cb(saved);
    } catch (e) {
      if (e instanceof ConflictError) {
        const owner = await (await import('../items.js')).getPart(e.rec.itemId);
        toast(`Code ${e.rec.code} already belongs to ${owner ? displayName(owner) : 'another part'}`, { error: true, duration: 5000 });
      } else {
        toast(e.message || 'Could not save', { error: true });
      }
    }
  });
  if (!editing && !prefill.model) {
    setTimeout(() => wrap.querySelector('[data-f="brand"]').focus({ preventScroll: true }), 80);
  }
  return s;
}

/** Unknown code: add / link / ignore. Exactly one callback fires. */
export function openUnknownCodeSheet(cls, { onAdd, onLink, onIgnore }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="big-code">${esc(cls.code)}</div>
    <div class="txn-sub" style="margin-bottom:16px">${esc(formatLabel(cls.format) || kindLabel(cls.kind))} · not in your inventory yet</div>
    <button class="btn btn-block btn-primary" data-add style="margin-bottom:10px">＋ Add as a new part</button>
    <button class="btn btn-block" data-link style="margin-bottom:10px">🔗 It's another barcode for a part I have</button>
    <button class="btn btn-block btn-ghost" data-ignore>Ignore</button>`;
  let picked = false;
  const s = sheet({ title: 'Unknown barcode', content: wrap, onClose: () => { if (!picked) onIgnore && onIgnore(); } });
  wrap.querySelector('[data-add]').addEventListener('click', () => { picked = true; s.close(); onAdd && onAdd(); });
  wrap.querySelector('[data-link]').addEventListener('click', () => { picked = true; s.close(); onLink && onLink(); });
  wrap.querySelector('[data-ignore]').addEventListener('click', () => s.close());
  return s;
}

/** Search + pick a part. onPicked(item|null). */
export async function openPartPicker({ title = 'Pick a part', hint = '', onPicked, exclude = null }) {
  const [items, codes, locs] = await Promise.all([allParts(), codesByItem(), allLocations()]);
  const map = locationMap(locs);
  const recent = [...items].sort((a, b) => (b.lastMovedAt || 0) - (a.lastMovedAt || 0));
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${hint ? `<div class="txn-sub" style="margin-bottom:10px">${hint}</div>` : ''}
    <div class="field"><input type="text" data-q placeholder="Search brand, model, type or code" autocomplete="off"></div>
    <div data-list></div>`;
  let done = false;
  const s = sheet({ title, content: wrap, onClose: () => { if (!done) onPicked && onPicked(null); } });
  const list = wrap.querySelector('[data-list]');
  const q = wrap.querySelector('[data-q]');
  const render = () => {
    const { searchParts } = window.__vanItems || {};
    const term = q.value.trim();
    let rows = term ? filterParts(recent, term, codes) : recent;
    if (exclude) rows = rows.filter(i => i.id !== exclude);
    rows = rows.slice(0, 40);
    list.innerHTML = rows.length ? rows.map(i => `
      <button type="button" class="pick-row" data-pick="${i.id}">
        <span class="grow">${esc(displayName(i))}<span class="sub">${esc(i.type || '')}${i.type ? ' · ' : ''}${esc(labelOf(i.locationId, map))} · ${fmtQty(i.qty)} ${i.unit === 'ft' ? 'ft' : 'pcs'}</span></span>
        <span class="shelf-badge">${esc(map.get(i.locationId)?.code || '—')}</span>
      </button>`).join('') : '<div class="empty">No parts match.</div>';
    list.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      done = true;
      const it = items.find(x => x.id === b.dataset.pick);
      s.close();
      onPicked && onPicked(it || null);
    }));
    void searchParts;
  };
  q.addEventListener('input', render);
  render();
  setTimeout(() => q.focus({ preventScroll: true }), 80);
  return s;
}

function filterParts(items, term, codes) {
  const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(it => {
    const hay = [it.brand, it.model, it.type].map(v => String(v || '').toLowerCase());
    for (const c of codes.get(it.id) || []) hay.push(c.code.toLowerCase());
    const s = hay.join(' ');
    return tokens.every(t => s.includes(t));
  });
}

/** Choose a location. onPicked(locationId|null|undefined) — undefined = cancelled. */
export async function openLocationPicker({ title = 'Move to', current = null, allowUnassigned = true, onPicked }) {
  const locs = await allLocations();
  const map = locationMap(locs);
  const sides = bySide(tree(locs));
  const row = (node, child = false) => `
    <button type="button" class="pick-row${node.loc.id === current ? ' on' : ''}${child ? ' child' : ''}" data-loc="${esc(node.loc.id)}">
      <span class="grow">${esc(node.loc.name)}${node.loc.tag ? `<span class="sub">${esc(node.loc.tag)} shelf</span>` : ''}</span>
      <span class="shelf-badge${node.loc.id === RET_ID ? ' ret' : ''}">${esc(node.loc.code)}</span>
    </button>
    ${node.children.map(c => row(c, true)).join('')}`;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    ${['left', 'right', 'none'].map(side => sides[side].length ? `
      <div class="section-title" style="margin-top:6px">${esc(SIDE_LABEL[side])}</div>
      ${sides[side].map(n => row(n)).join('')}` : '').join('')}
    ${allowUnassigned ? `<button type="button" class="pick-row${!current ? ' on' : ''}" data-loc=""><span class="grow">Unassigned</span><span class="shelf-badge muted">—</span></button>` : ''}`;
  let done = false;
  const s = sheet({ title, content: wrap, onClose: () => { if (!done) onPicked && onPicked(undefined); } });
  wrap.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', () => {
    done = true;
    s.close();
    onPicked && onPicked(b.dataset.loc || null);
  }));
  void map;
  return s;
}

/** One-line text prompt. onDone(text|null). */
export function openTextSheet({ title, label = '', value = '', placeholder = '', okLabel = 'Save', onDone }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field">${label ? `<label>${esc(label)}</label>` : ''}<input type="text" data-t value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>${esc(okLabel)}</button>
    </div>`;
  const s = sheet({ title, content: wrap, onClose: () => onDone && onDone(null) });
  const input = wrap.querySelector('[data-t]');
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  const ok = () => { const cb = onDone; onDone = null; const val = input.value; s.close(); if (cb) cb(val); };
  wrap.querySelector('[data-ok]').addEventListener('click', ok);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
  setTimeout(() => { input.focus({ preventScroll: true }); input.select(); }, 80);
  return s;
}

/** Job / note editor for a movement. onDone({jobRef, note}|null). */
export async function openJobSheet({ jobRef = '', note = '', onDone }) {
  const jobs = await recentJobs();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field">
      <label>Job / customer</label>
      <input type="text" data-job value="${esc(jobRef || '')}" placeholder="Where did it go?" autocomplete="off">
      ${jobs.length ? `<div class="chips">${jobs.map(j => `<button type="button" class="chip" data-jobchip>${esc(j)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="field"><label>Note</label><input type="text" data-note value="${esc(note || '')}" autocomplete="off"></div>
    <div class="sheet-actions">
      <button type="button" class="btn" data-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-ok>Save</button>
    </div>`;
  const s = sheet({ title: 'Job / note', content: wrap, onClose: () => onDone && onDone(null) });
  const jobInput = wrap.querySelector('[data-job]');
  wrap.querySelectorAll('[data-jobchip]').forEach(c => c.addEventListener('click', () => { jobInput.value = c.textContent; }));
  wrap.querySelector('[data-cancel]').addEventListener('click', () => s.close());
  wrap.querySelector('[data-ok]').addEventListener('click', () => {
    const cb = onDone; onDone = null;
    const out = { jobRef: jobInput.value.trim(), note: wrap.querySelector('[data-note]').value.trim() };
    s.close();
    if (cb) cb(out);
  });
  setTimeout(() => jobInput.focus({ preventScroll: true }), 80);
}

/** Offer to move a code that belongs to another part. Returns true when relinked. */
export async function offerRelink(conflict, targetItem) {
  const { getPart } = await import('../items.js');
  const owner = await getPart(conflict.rec.itemId);
  const yes = await confirmDialog(
    `${conflict.rec.code} is already linked to ${owner ? displayName(owner) : 'another part'}. Move it to ${displayName(targetItem)} instead?`,
    { okLabel: 'Move code' });
  if (!yes) return false;
  await relinkCode(conflict.rec.norm, targetItem.id);
  return true;
}

export { partCompare };
