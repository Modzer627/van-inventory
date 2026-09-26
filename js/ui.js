// Small DOM/UI toolkit: templates, toasts, bottom sheets, feedback sounds.
// (Copied from StockTracker's ui.js with a few additions at the bottom.)

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtQty(n) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return String(parseFloat(v.toFixed(3)));
}

export function fmtQtyUnit(n, unit = 'ea') {
  const u = unit || 'ea';
  return `${fmtQty(n)} ${u === 'ea' ? (Math.abs(Number(n)) === 1 ? 'pc' : 'pcs') : u}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function isoDate(ts = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysAgo(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / (24 * 3600 * 1000));
}

export function agoLabel(ts) {
  const d = daysAgo(ts);
  if (d === null) return 'never';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} yr ago`;
}

/* ---------- toast ---------- */
let toastTimer = null;
export function toast(msg, { error = false, action = null, actionLabel = 'OK', duration = 2600 } = {}) {
  const root = $('#toast-root');
  if (!root) return;
  root.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' err' : '');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = actionLabel;
    b.addEventListener('click', () => { root.innerHTML = ''; action(); });
    t.appendChild(b);
    duration = Math.max(duration, 5000);
  }
  root.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (t.parentNode) t.remove(); }, duration);
}

/* ---------- bottom sheet ---------- */
export function sheet({ title = '', content, onClose = null, dismissable = true }) {
  const root = $('#sheet-root');
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  const panel = document.createElement('div');
  panel.className = 'sheet';
  panel.innerHTML = `<div class="sheet-grip"></div>` + (title ? `<h2>${title}</h2>` : '');
  if (typeof content === 'string') panel.insertAdjacentHTML('beforeend', content);
  else if (content) panel.appendChild(content);
  overlay.appendChild(panel);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && dismissable) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(overlay);
  return { close, panel, get closed() { return closed; } };
}

export function anySheetOpen() {
  const root = $('#sheet-root');
  return !!(root && root.childElementCount);
}

export function closeTopSheet() {
  const root = $('#sheet-root');
  const top = root && root.lastElementChild;
  if (top) top.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
}

export function confirmDialog(msg, { danger = false, okLabel = 'Confirm', title = '' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm-box';
    wrap.innerHTML = `<p>${esc(msg)}</p>`;
    const actions = document.createElement('div');
    actions.className = 'sheet-actions';
    const no = document.createElement('button');
    no.className = 'btn';
    no.textContent = 'Cancel';
    const yes = document.createElement('button');
    yes.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    yes.textContent = okLabel;
    actions.append(no, yes);
    wrap.appendChild(actions);
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const s = sheet({ title, content: wrap, onClose: () => done(false) });
    no.addEventListener('click', () => s.close());
    yes.addEventListener('click', () => { done(true); s.close(); });
  });
}

/* ---------- audio / haptic feedback ---------- */
let audioCtx = null;
let soundEnabled = true;
let hapticsEnabled = true;
export function setSoundEnabled(on) { soundEnabled = !!on; }
export function setHapticsEnabled(on) { hapticsEnabled = !!on; }

export function unlockAudio() {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio is best-effort */ }
}

export function beep(ok = true) {
  if (!soundEnabled || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = ok ? 880 : 220;
    osc.type = 'square';
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.13);
  } catch { /* best-effort */ }
}

export function buzz(ms = 40) {
  if (!hapticsEnabled) return;
  try { navigator.vibrate && navigator.vibrate(ms); } catch { /* no vibrate */ }
}

/** Full-screen colour flash behind the scan UI (green ok / red fail). */
export function flashScreen(ok = true) {
  const el = document.getElementById('scan-flash');
  if (!el) return;
  el.classList.remove('ok', 'err');
  void el.offsetWidth; // restart the animation
  el.classList.add(ok ? 'ok' : 'err');
  setTimeout(() => el.classList.remove('ok', 'err'), 260);
}

/** Debounce helper for search boxes. */
export function debounce(fn, ms = 120) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function pluralize(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}
