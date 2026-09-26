// Scan screen: Remove / Add / Find, plus count / move / link modes entered from
// other screens. The camera feeds ScanSession; this file only renders.
import { metaGet, metaSet, applyStockChange } from '../db.js';
import { Scanner, scanImage } from '../scanner.js';
import { ScanSession, MODES, STEPS_EA, STEPS_FT } from '../scan-session.js';
import { linkCode } from '../barcodes.js';
import { classifyCode } from '../codes.js';
import { moveItem, allLocations, locationMap, labelOf, keyOf, UNASSIGNED_KEY } from '../locations.js';
import { openCount, saveCount, tally, setLine } from '../counts.js';
import { displayName, getPart, ConflictError } from '../items.js';
import { esc, fmtQty, toast, beep, buzz, flashScreen } from '../ui.js';
import * as nav from '../nav.js';
import { openAmountSheet, openPartForm, openQtySheet, openUnknownCodeSheet, openPartPicker, openLocationPicker, openJobSheet, openTextSheet, offerRelink } from './sheets.js';

const ui = () => document.getElementById('scan-ui');
const video = () => document.getElementById('scan-video');

let scanner = null;
let session = null;
let extra = null;        // null | {kind:'count', rec, key, label} | {kind:'move', locationId, label} | {kind:'link', item}
let locMap = new Map();
let lastItem = null;
let cardTimer = null;
let wakeLock = null;
let visHandler = null;
let cameras = [];
let busy = false;

const unitWord = (item, n = 2) => (item.unit === 'ft' ? 'ft' : (Math.abs(n) === 1 ? 'pc' : 'pcs'));

/* ---------- render ---------- */
function render() {
  const modes = Object.entries(MODES).map(([m, label]) =>
    `<button data-mode="${m}" class="${m === session.mode ? 'on' : ''}">${label}</button>`).join('');
  let top;
  if (extra) {
    const label = extra.kind === 'count' ? `Counting · ${extra.label}`
      : extra.kind === 'move' ? `Move to ${extra.label}`
      : `Link code → ${displayName(extra.item)}`;
    top = `
      <button class="icon-btn" data-exit aria-label="Done">✕</button>
      <div class="seg" style="pointer-events:none"><button class="on" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</button></div>
      ${extra.kind === 'count' ? '<button class="btn btn-sm btn-primary" data-review>Review</button>' : ''}`;
  } else {
    top = `<div class="seg">${modes}</div><button class="icon-btn" data-settings aria-label="Settings">⚙️</button>`;
  }
  ui().innerHTML = `
    <div class="scan-top">${top}</div>
    <div class="reticle"></div>
    <div class="scan-bottom">
      <div class="pending-card" data-card hidden></div>
      <div class="scan-chip" data-chip></div>
      ${!extra || extra.kind === 'count' ? '<div class="step-row" data-steps></div>' : ''}
      <div class="zoom-row" data-zoomrow hidden><span>Zoom</span><input type="range" data-zoom min="1" max="3" step="0.1" value="1"></div>
      <div class="scan-controls">
        <button class="icon-btn" data-torch aria-label="Torch" hidden>🔦</button>
        <button class="icon-btn" data-zoomtoggle aria-label="Zoom" hidden>🔍</button>
        <button class="icon-btn" data-camera aria-label="Switch camera" hidden>🔄</button>
        <button class="icon-btn" data-keyboard aria-label="Type a code">⌨️</button>
        <label class="icon-btn" aria-label="Scan from photo">🖼️<input type="file" accept="image/*" data-photo hidden></label>
      </div>
      <div class="scan-msg" data-msg>Starting camera…</div>
    </div>`;
  renderSteps();
  wire();
}

function renderSteps() {
  const row = ui().querySelector('[data-steps]');
  if (!row) return;
  const cur = session.stepEa;
  const std = STEPS_EA.includes(cur);
  row.innerHTML = `<span class="lbl">${extra && extra.kind === 'count' ? 'Per scan' : 'Step'}</span>` +
    STEPS_EA.map(n => `<button class="chip${cur === n ? ' on' : ''}" data-stepval="${n}">${n}</button>`).join('') +
    `<button class="chip${std ? '' : ' on'}" data-stepcustom>${std ? '…' : fmtQty(cur)}</button>`;
  row.querySelectorAll('[data-stepval]').forEach(b => b.addEventListener('click', async () => { await session.setStep(Number(b.dataset.stepval), 'ea'); renderSteps(); }));
  row.querySelector('[data-stepcustom]').addEventListener('click', () => withPausedScanner(done => openQtySheet({
    title: 'Step per scan', okLabel: 'Use', initial: cur, unit: 'ea',
    onDone: async (q) => { if (q) { await session.setStep(q, 'ea'); renderSteps(); } done(); },
  })));
}

function wire() {
  const root = ui();
  root.querySelector('[data-settings]')?.addEventListener('click', () => nav.show('settings'));
  root.querySelector('[data-exit]')?.addEventListener('click', () => nav.back());
  root.querySelector('[data-review]')?.addEventListener('click', () => nav.show('count-review'));
  root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', async () => {
    await session.setMode(b.dataset.mode);
    hideCard();
    setChip('');
    root.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === session.mode));
    setMsg(defaultMsg());
  }));
  root.querySelector('[data-torch]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const on = !btn.classList.contains('on');
    if (await scanner.setTorch(on)) btn.classList.toggle('on', on);
  });
  const zoomRow = root.querySelector('[data-zoomrow]');
  root.querySelector('[data-zoomtoggle]').addEventListener('click', () => { zoomRow.hidden = !zoomRow.hidden; });
  root.querySelector('[data-zoom]').addEventListener('input', async (e) => {
    const v = Number(e.target.value);
    if (await scanner.setZoom(v)) metaSet('cameraZoom', v);
  });
  root.querySelector('[data-camera]').addEventListener('click', cycleCamera);
  root.querySelector('[data-keyboard]').addEventListener('click', () => withPausedScanner(done => openTextSheet({
    title: 'Type a code', label: 'Barcode or part number', placeholder: '843122104825', okLabel: 'Look up',
    onDone: async (text) => { done(); if (text && text.trim()) await handleCode(text.trim(), 'manual'); },
  })));
  root.querySelector('[data-photo]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setMsg('Reading photo…');
    try {
      const codes = await scanImage(file);
      if (!codes.length) { toast('No barcode found in that photo', { error: true }); setMsg(defaultMsg()); return; }
      await handleCode(codes[0].rawValue, codes[0].format);
    } catch {
      toast('Could not read that photo', { error: true });
    }
    setMsg(defaultMsg());
  });
  root.querySelector('[data-chip]').addEventListener('click', onChipTap);
}

function defaultMsg() {
  if (extra && extra.kind === 'count') return `Scan each part on <b>${esc(extra.label)}</b> — every scan counts ${fmtQty(session.stepEa)}`;
  if (extra && extra.kind === 'move') return `Scan parts to move them to <b>${esc(extra.label)}</b>`;
  if (extra && extra.kind === 'link') return `Scan the box label to link it to <b>${esc(displayName(extra.item))}</b>`;
  return { remove: 'Scan a part to take it off the van', add: 'Scan a part to add stock', find: 'Scan a part to see its shelf' }[session.mode];
}

function setChip(html) {
  const chip = ui().querySelector('[data-chip]');
  if (!chip) return;
  chip.innerHTML = html;
  chip.classList.toggle('show', !!html);
}
function showChip(html) { hideCard(); setChip(html); }
function setMsg(html) {
  const m = ui().querySelector('[data-msg]');
  if (m) m.innerHTML = html;
}
function flashReticle(ok = true) {
  const r = ui().querySelector('.reticle');
  if (!r) return;
  r.classList.add('hit');
  setTimeout(() => r.classList.remove('hit'), 220);
  void ok;
}
function feedback(ok = true) {
  beep(ok);
  buzz(ok ? 40 : 120);
  flashScreen(ok);
  if (ok) flashReticle();
}

/* ---------- cards ---------- */
function cardEl() { return ui().querySelector('[data-card]'); }
function hideCard() {
  clearTimeout(cardTimer);
  const c = cardEl();
  if (c) { c.hidden = true; c.innerHTML = ''; }
}
function armCardTimer(ms) {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => { hideCard(); session.clearPending(); }, ms);
}

function showAppliedCard(res) {
  const { item, before, after, mode, qty, txn } = res;
  const card = cardEl();
  if (!card) return;
  setChip('');
  card.hidden = false;
  card.classList.toggle('warn', after < 0);
  const nudge = item.unit === 'ft' ? 5 : 1;
  card.innerHTML = `
    <div class="pc-head"><span class="grow">${esc(displayName(item))}</span><span class="shelf-badge">${esc(labelOf(item.locationId, locMap))}</span></div>
    <div class="pc-qty">${fmtQty(before)} → <span class="${after < 0 ? 'neg' : ''}">${fmtQty(after)}</span><span class="u">${esc(unitWord(item, after))}</span><span class="delta">${mode === 'remove' ? '−' : '+'}${fmtQty(qty)}</span></div>
    ${after < 0 ? '<div class="pc-warn">Below zero — check the shelf and set the real count.</div>' : ''}
    <div class="pc-actions">
      <button data-c="undo" class="danger">Undo</button>
      <button data-c="minus">−${nudge}</button>
      <button data-c="plus">+${nudge}</button>
      <button data-c="exact">Exact…</button>
      <button data-c="job">${txn && txn.jobRef ? esc(txn.jobRef) : 'Job / note'}</button>
    </div>`;
  card.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => onCardAction(b.dataset.c)));
  armCardTimer(6000);
}

async function onCardAction(action) {
  const p = session.pending;
  if (!p) { hideCard(); return; }
  try {
    if (action === 'undo') {
      await session.undoPending();
      showChip(`<b>${esc(displayName(p.item))}</b> — undone, back to ${fmtQty(p.before)} ${esc(unitWord(p.item, p.before))}`);
      return;
    }
    if (action === 'minus' || action === 'plus') {
      const np = await session.nudgePending(action === 'plus' ? 1 : -1);
      if (!np) { showChip(`<b>${esc(displayName(p.item))}</b> — undone`); return; }
      showAppliedCard({ item: np.item, before: np.before, after: np.after, mode: np.mode, qty: np.qty, txn: np.txn });
      return;
    }
    if (action === 'exact') {
      armCardTimer(20000);
      withPausedScanner(done => openQtySheet({
        title: `${p.mode === 'remove' ? 'Quantity removed' : 'Quantity added'} — <span class="sheet-item-name">${esc(displayName(p.item))}</span>`,
        okLabel: 'Apply', initial: p.qty, unit: p.item.unit, chips: p.item.unit === 'ft' ? STEPS_FT : null, allowZero: true,
        onDone: async (q) => {
          done();
          if (q === null) { armCardTimer(6000); return; }
          const np = await session.amendPending(q);
          if (!np) showChip(`<b>${esc(displayName(p.item))}</b> — undone`);
          else showAppliedCard({ item: np.item, before: np.before, after: np.after, mode: np.mode, qty: np.qty, txn: np.txn });
        },
      }));
      return;
    }
    if (action === 'job') {
      armCardTimer(30000);
      withPausedScanner(done => openJobSheet({
        jobRef: p.txn.jobRef, note: p.txn.note,
        onDone: async (v) => {
          done();
          if (v) { await session.setPendingJob(v.jobRef, v.note); const b = cardEl()?.querySelector('[data-c="job"]'); if (b) b.textContent = v.jobRef || 'Job / note'; }
          armCardTimer(6000);
        },
      }));
    }
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function showFindCard(item) {
  const card = cardEl();
  if (!card) return;
  setChip('');
  clearTimeout(cardTimer);
  card.hidden = false;
  card.classList.remove('warn');
  const step = session.stepFor(item);
  card.innerHTML = `
    <div class="pc-head"><span class="grow">${esc(displayName(item))}</span><span class="shelf-badge">${esc(labelOf(item.locationId, locMap))}</span></div>
    <div class="pc-qty">${fmtQty(item.qty)}<span class="u">${esc(unitWord(item, item.qty))} on the van</span>${item.type ? `<span class="u">· ${esc(item.type)}</span>` : ''}</div>
    <div class="pc-actions">
      <button data-f="open" class="primary">Open</button>
      <button data-f="move">Move…</button>
      <button data-f="set">Set qty…</button>
      <button data-f="minus">−${fmtQty(step)}</button>
      <button data-f="plus">+${fmtQty(step)}</button>
    </div>`;
  card.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => onFindAction(b.dataset.f, item)));
  cardTimer = setTimeout(hideCard, 15000);
}

async function onFindAction(action, item) {
  try {
    if (action === 'open') { nav.show('part', { id: item.id }); return; }
    if (action === 'move') {
      withPausedScanner(done => openLocationPicker({
        title: `Move ${displayName(item)} to`, current: item.locationId,
        onPicked: async (locId) => {
          done();
          if (locId === undefined) return;
          await moveItem(item.id, locId, { source: 'scan' });
          if (locId) metaSet('lastLocationId', locId);
          showChip(`<b>${esc(displayName(item))}</b> → ${esc(labelOf(locId, locMap))}`);
        },
      }));
      return;
    }
    if (action === 'set') {
      withPausedScanner(done => openQtySheet({
        title: `Set quantity — <span class="sheet-item-name">${esc(displayName(item))}</span>`, okLabel: 'Set',
        initial: Math.max(0, item.qty), unit: item.unit, chips: item.unit === 'ft' ? STEPS_FT : null, allowZero: true,
        onDone: async (q) => {
          done();
          if (q === null || q === item.qty) return;
          await applyStockChange({ itemId: item.id, to: q, type: 'set', source: 'scan', note: 'Set from Find' });
          showChip(`<b>${esc(displayName(item))}</b> set to ${fmtQty(q)} ${esc(unitWord(item, q))}`);
        },
      }));
      return;
    }
    if (action === 'minus' || action === 'plus') {
      const fresh = await getPart(item.id);
      const res = await session.applyQty(fresh, session.stepFor(fresh), action === 'minus' ? 'remove' : 'add');
      feedback(true);
      showAppliedCard(res);
    }
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function showCountMoveCard(item, counted) {
  const card = cardEl();
  if (!card) return;
  setChip('');
  clearTimeout(cardTimer);
  card.hidden = false;
  card.classList.remove('warn');
  card.innerHTML = `
    <div class="pc-head"><span class="grow">${esc(displayName(item))}</span><span class="shelf-badge">${esc(labelOf(item.locationId, locMap))}</span></div>
    <div class="pc-qty">counted ${fmtQty(counted)}<span class="u">here on ${esc(extra.label)}</span></div>
    <div class="pc-warn" style="color:#fdba74">Filed under ${esc(labelOf(item.locationId, locMap))} — move it here?</div>
    <div class="pc-actions">
      <button data-cm="move" class="primary">Move here</button>
      <button data-cm="keep">Keep it there</button>
      <button data-cm="exact">Set count…</button>
    </div>`;
  card.querySelectorAll('[data-cm]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.cm;
    if (a === 'move') {
      await moveItem(item.id, extra.key === UNASSIGNED_KEY ? null : extra.key, { source: 'count', note: `Found here during count ${extra.rec.label}` });
      showChip(`<b>${esc(displayName(item))}</b> moved to ${esc(extra.label)}`);
    } else if (a === 'exact') {
      openExactCount(item);
    } else hideCard();
  }));
  cardTimer = setTimeout(hideCard, 15000);
}

function openExactCount(item) {
  const rec = extra.rec;
  const cur = rec.lines[item.id] ? rec.lines[item.id].counted : (item.unit === 'ft' ? item.qty : 0);
  withPausedScanner(done => openQtySheet({
    title: `Counted — <span class="sheet-item-name">${esc(displayName(item))}</span>`, okLabel: 'Set count',
    initial: cur, unit: item.unit, chips: item.unit === 'ft' ? STEPS_FT : null, allowZero: true,
    onDone: async (q) => {
      done();
      if (q === null) return;
      setLine(rec, item, q, extra.key);
      await saveCount(rec);
      showChip(`<b>${esc(displayName(item))}</b> — counted ${fmtQty(q)} ${esc(unitWord(item, q))}`);
    },
  }));
}

function onChipTap() {
  if (!lastItem) return;
  if (extra && extra.kind === 'count') openExactCount(lastItem);
  else nav.show('part', { id: lastItem.id });
}

/* ---------- code handling ---------- */
export async function handleCode(raw, format = null) {
  if (busy || !session) return { result: 'busy' };
  busy = true;
  try {
    if (extra && extra.kind === 'link') return await handleLink(raw, format);
    const r = await session.resolve(raw, format);
    if (r.kind === 'empty' || r.kind === 'dup') return { result: r.kind };
    if (r.kind === 'unknown') { feedback(false); handleUnknown(r); return { result: 'unknown', code: r.cls.code }; }
    const item = r.item;
    lastItem = item;
    if (extra && extra.kind === 'move') {
      if ((item.locationId || null) === (extra.locationId || null)) { feedback(true); showChip(`<b>${esc(displayName(item))}</b> is already on ${esc(extra.label)}`); return { result: 'move-noop', item }; }
      feedback(true);
      await moveItem(item.id, extra.locationId, { source: 'scan' });
      showChip(`<b>${esc(displayName(item))}</b> → ${esc(extra.label)}`);
      return { result: 'moved', item };
    }
    if (extra && extra.kind === 'count') { feedback(true); return await countHit(item); }
    const res = await session.act(item);
    if (res.action === 'find') { feedback(true); showFindCard(item); return { result: 'find', item }; }
    if (res.action === 'needs-qty') {
      feedback(true);
      withPausedScanner(done => openAmountSheet({
        item, mode: res.mode, initial: res.step,
        onDone: async (v) => {
          try { if (v) showAppliedCard(await session.applyQty(item, v.qty, res.mode, v)); }
          catch (e) { toast(e.message, { error: true }); }
          done();
        },
      }));
      return { result: 'needs-qty', item };
    }
    feedback(true);
    showAppliedCard(res);
    return { result: 'applied', item: res.item, before: res.before, after: res.after, txn: res.txn };
  } catch (e) {
    toast(e.message || 'Could not process that code', { error: true });
    return { result: 'error', error: e.message };
  } finally {
    busy = false;
  }
}

async function countHit(item) {
  const rec = extra.rec;
  if (item.unit === 'ft') { openExactCount(item); return { result: 'count-ft', item }; }
  const n = tally(rec, item, session.stepEa, extra.key);
  await saveCount(rec);
  if (keyOf(item) !== extra.key) showCountMoveCard(item, n);
  else showChip(`<b>${esc(displayName(item))}</b> — counted ${fmtQty(n)} <span style="opacity:.7">(tap to set exact)</span>`);
  return { result: 'counted', item, counted: n };
}

function handleUnknown(r) {
  const cls = r.cls;
  withPausedScanner(async (done) => {
    const lastLoc = await metaGet('lastLocationId', null);
    const defaultLoc = extra && extra.kind === 'move' ? extra.locationId
      : extra && extra.kind === 'count' ? (extra.key === UNASSIGNED_KEY ? null : extra.key)
      : lastLoc;
    openUnknownCodeSheet(cls, {
      onAdd: () => openPartForm({
        prefill: { codes: [{ code: cls.raw, format: cls.format }], qty: (!extra && session.mode === 'add') ? session.stepEa : 0, locationId: defaultLoc },
        onSaved: async (created) => {
          if (created) {
            if (extra && extra.kind === 'count') { setLine(extra.rec, created, created.qty, extra.key); await saveCount(extra.rec); }
            showChip(`<b>${esc(displayName(created))}</b> added${created.qty ? ` · ${fmtQty(created.qty)} ${esc(unitWord(created, created.qty))}` : ''}`);
          }
          done();
        },
      }),
      onLink: () => openPartPicker({
        title: 'Which part is this code for?', hint: `Code <b>${esc(cls.code)}</b> will be added to the part you pick.`,
        onPicked: async (item) => {
          if (!item) { done(); return; }
          try {
            await linkCode(item.id, cls.raw, cls.format);
            toast(`Linked to ${displayName(item)}`);
            session.forget(cls.norm);
            done();
            await handleCode(cls.raw, cls.format);
          } catch (e) {
            if (e instanceof ConflictError && await offerRelink(e, item)) {
              session.forget(cls.norm);
              done();
              await handleCode(cls.raw, cls.format);
              return;
            }
            if (!(e instanceof ConflictError)) toast(e.message, { error: true });
            done();
          }
        },
      }),
      onIgnore: done,
    });
  });
}

async function handleLink(raw, format) {
  const cls = classifyCode(raw, format);
  if (!cls || session.isDuplicate(cls.norm)) return { result: 'dup' };
  const item = extra.item;
  try {
    await linkCode(item.id, raw, format);
    feedback(true);
    showChip(`Linked <b>${esc(cls.code)}</b> to ${esc(displayName(item))}`);
    return { result: 'linked', item };
  } catch (e) {
    feedback(false);
    if (e instanceof ConflictError) {
      const owner = await getPart(e.rec.itemId);
      withPausedScanner(async (done) => {
        const moved = await offerRelink(e, item);
        if (moved) showChip(`Code moved from ${esc(owner ? displayName(owner) : 'another part')} to ${esc(displayName(item))}`);
        done();
      });
      return { result: 'conflict' };
    }
    toast(e.message, { error: true });
    return { result: 'error' };
  }
}

/** Pause code handling while a sheet is up, resume (with warmup) after. */
function withPausedScanner(fn) {
  if (scanner) scanner.pause();
  let resumed = false;
  const done = () => { if (!resumed) { resumed = true; if (scanner) scanner.resume(); } };
  fn(done);
}

/* ---------- camera ---------- */
async function startCamera() {
  scanner = scanner || new Scanner(video());
  scanner.onCode = (value, format) => { handleCode(value, format); };
  scanner.onError = () => { /* per-frame decode hiccups are normal */ };
  const deviceId = await metaGet('cameraDeviceId', null);
  const zoom = await metaGet('cameraZoom', null);
  try {
    await scanner.start({ deviceId, zoom });
    if (scanner.deviceId && scanner.deviceId !== deviceId) await metaSet('cameraDeviceId', scanner.deviceId);
    setMsg(defaultMsg());
    await updateCameraControls();
  } catch (e) {
    showCameraError(e);
  }
}

async function updateCameraControls() {
  const root = ui();
  const torch = root.querySelector('[data-torch]');
  if (torch) { torch.hidden = !scanner.hasTorch(); torch.classList.remove('on'); }
  const range = scanner.zoomRange();
  const zt = root.querySelector('[data-zoomtoggle]');
  const zi = root.querySelector('[data-zoom]');
  if (zt && zi) {
    zt.hidden = !range;
    if (range) { zi.min = range.min; zi.max = range.max; zi.step = range.step; zi.value = scanner.getZoom() ?? range.min; }
  }
  cameras = (await Scanner.listCameras()).filter(c => !/front|user|face/i.test(c.label));
  const cb = root.querySelector('[data-camera]');
  if (cb) cb.hidden = cameras.length < 2;
}

async function cycleCamera() {
  if (cameras.length < 2) return;
  const idx = cameras.findIndex(c => c.deviceId === scanner.deviceId);
  const next = cameras[(idx + 1) % cameras.length];
  try {
    await scanner.start({ deviceId: next.deviceId, zoom: await metaGet('cameraZoom', null) });
    await metaSet('cameraDeviceId', scanner.deviceId);
    await updateCameraControls();
    toast(next.label ? `Camera: ${next.label}` : 'Camera switched');
  } catch (e) {
    showCameraError(e);
  }
}

function showCameraError(e) {
  const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
  setMsg(denied
    ? 'Camera access was blocked. Allow the camera for this app in your phone settings, or type the code.'
    : `Camera unavailable (${esc(e && e.name || 'error')}). You can type a code or scan from a photo.`);
  if (denied) toast('Camera permission needed', { error: true });
}

async function acquireWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

/* ---------- view ---------- */
export default {
  async show(params = {}) {
    session = session || new ScanSession();
    await session.load();
    session.clearPending();
    extra = null;
    lastItem = null;
    const locs = await allLocations();
    locMap = locationMap(locs);
    if (params.count) {
      const rec = await openCount();
      if (!rec) { toast('No count in progress', { error: true }); nav.back(); return; }
      const key = params.key || rec.cursor || UNASSIGNED_KEY;
      extra = { kind: 'count', rec, key, label: key === UNASSIGNED_KEY ? 'Unassigned' : labelOf(key, locMap) };
    } else if (params.move !== undefined) {
      const locId = params.move === UNASSIGNED_KEY ? null : params.move;
      extra = { kind: 'move', locationId: locId, label: labelOf(locId, locMap) };
    } else if (params.link) {
      const item = await getPart(params.link);
      if (!item) { nav.back(); return; }
      extra = { kind: 'link', item };
    }
    render();
    await startCamera();
    acquireWakeLock();
    visHandler = async () => {
      if (document.hidden) { scanner && scanner.stop(); releaseWakeLock(); }
      else if (nav.currentScreen() === 'scan') { await startCamera(); acquireWakeLock(); }
    };
    document.addEventListener('visibilitychange', visHandler);
  },

  async hide() {
    if (visHandler) { document.removeEventListener('visibilitychange', visHandler); visHandler = null; }
    if (scanner) scanner.stop();
    releaseWakeLock();
    clearTimeout(cardTimer);
    if (extra && extra.kind === 'count') await saveCount(extra.rec);
  },

  /** Dev hook: feed a code as if the camera saw it. */
  simulate(code, format = 'code_128') {
    return handleCode(code, format);
  },
};
