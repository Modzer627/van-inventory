// In-app navigation: five tab roots plus a screen stack inside the current
// tab. Deliberately never changes the URL (URL changes can drop the camera
// permission in home-screen apps); the Android back gesture is handled with
// same-URL history entries instead.
import { anySheetOpen, closeTopSheet } from './ui.js';

export const TABS = ['scan', 'parts', 'shelves', 'count', 'insights'];

const screens = new Map();
const stack = [];
let popping = false;

export function register(name, view) {
  screens.set(name, view);
}

function sectionOf(name) {
  return document.getElementById(`screen-${name}`);
}

function announce(name) {
  try { window.dispatchEvent(new CustomEvent('nav:changed', { detail: { name, depth: stack.length } })); } catch { /* noop */ }
}

async function leaveCurrent() {
  const current = stack[stack.length - 1];
  if (!current) return;
  const view = screens.get(current.name);
  if (view && view.hide) await view.hide();
  const sec = sectionOf(current.name);
  if (sec) sec.hidden = true;
}

async function enter(entry) {
  const sec = sectionOf(entry.name);
  if (sec) sec.hidden = false;
  const view = screens.get(entry.name);
  if (view && view.show) await view.show(entry.params || {});
  announce(entry.name);
}

export async function show(name, params = {}, { replace = false } = {}) {
  await leaveCurrent();
  if (replace) stack.pop();
  stack.push({ name, params });
  if (!replace && stack.length > 1) pushHistory();
  await enter(stack[stack.length - 1]);
}

export async function back(fallback = 'scan') {
  const leaving = stack.pop();
  if (leaving) {
    const view = screens.get(leaving.name);
    if (view && view.hide) await view.hide();
    const sec = sectionOf(leaving.name);
    if (sec) sec.hidden = true;
  }
  let target = stack[stack.length - 1];
  if (!target) {
    target = { name: fallback, params: {} };
    stack.push(target);
  }
  await enter(target);
}

export function currentScreen() {
  return stack[stack.length - 1]?.name || null;
}

export function currentParams() {
  return stack[stack.length - 1]?.params || {};
}

export function depth() {
  return stack.length;
}

/** Jump to a tab root, dropping any stacked screens. */
export async function showTab(name, params = {}) {
  await leaveCurrent();
  stack.length = 0;
  stack.push({ name, params });
  await enter(stack[0]);
}

export const resetTo = showTab;

/** Re-run the current screen's show() (after data changed). */
export async function refresh() {
  const cur = stack[stack.length - 1];
  if (!cur) return;
  const view = screens.get(cur.name);
  if (view && view.refresh) await view.refresh();
  else if (view && view.show) await view.show(cur.params || {});
}

/* ---------- Android back gesture ---------- */
function pushHistory() {
  try { history.pushState({ van: stack.length }, ''); } catch { /* ignore */ }
}

export function installBackHandler() {
  window.addEventListener('popstate', async () => {
    if (popping) return;
    if (anySheetOpen()) {
      closeTopSheet();
      pushHistory(); // keep one entry so the next gesture still reaches us
      return;
    }
    if (stack.length > 1) {
      popping = true;
      try { await back(); } finally { popping = false; }
    }
    // At a tab root the gesture falls through and exits the app (normal Android behaviour).
  });
}
