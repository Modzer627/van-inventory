// Scan state machine (no DOM): mode, step, dedupe, the pending action card and
// its undo/amend. The scan view renders whatever this returns; window.__scan
// drives it without a camera.
import { metaGet, metaSet, applyStockChange } from './db.js';
import { findByCode, noteVariant } from './barcodes.js';
import { undoTxn, amendTxn, updateTxnMeta, pushJob } from './txns.js';

export const MODES = { remove: 'Remove', add: 'Add', find: 'Find' };
export const STEPS_EA = [1, 2, 5, 10];
export const STEPS_FT = [10, 25, 50, 100];
const DEDUPE_MS = 1500;

export class ScanSession {
  constructor() {
    this.mode = 'remove';
    this.stepEa = 1;
    this.stepFt = 25;
    this.confirmEach = false;
    this.lastSeen = new Map();  // norm → performance.now()
    this.pending = null;        // { txn, item, before, after, mode, qty, at }
  }

  async load() {
    this.mode = await metaGet('lastScanMode', 'remove');
    if (!MODES[this.mode]) this.mode = 'remove';
    this.stepEa = Number(await metaGet('stepEa', 1)) || 1;
    this.stepFt = Number(await metaGet('stepFt', 25)) || 25;
    this.confirmEach = !!(await metaGet('confirmEachScan', false));
    return this;
  }

  async setMode(mode) {
    if (!MODES[mode]) return;
    this.mode = mode;
    this.pending = null;
    await metaSet('lastScanMode', mode);
  }

  async setStep(n, unit = 'ea') {
    const v = Math.max(0.001, Number(n) || 1);
    if (unit === 'ft') { this.stepFt = v; await metaSet('stepFt', v); }
    else { this.stepEa = v; await metaSet('stepEa', v); }
  }

  stepFor(item) { return item && item.unit === 'ft' ? this.stepFt : this.stepEa; }

  isDuplicate(norm) {
    const now = performance.now();
    const last = this.lastSeen.get(norm) ?? -Infinity;
    this.lastSeen.set(norm, now);
    return now - last < DEDUPE_MS;
  }

  forget(norm) { this.lastSeen.delete(norm); }

  /** Resolve a code → { kind: 'empty'|'dup'|'unknown'|'hit', cls, rec, item } */
  async resolve(raw, format = null) {
    const r = await findByCode(raw, format);
    if (!r.cls) return { kind: 'empty' };
    if (this.isDuplicate(r.cls.norm)) return { kind: 'dup', ...r };
    if (!r.item) return { kind: 'unknown', ...r };
    if (r.rec) noteVariant(r.rec, r.cls);
    return { kind: 'hit', ...r };
  }

  /**
   * Decide what the current mode does with a known part.
   * → { action: 'find' | 'needs-qty' | 'applied', ... }
   */
  async act(item, { mode = this.mode } = {}) {
    if (mode === 'find') return { action: 'find', item };
    const step = this.stepFor(item);
    if (item.unit === 'ft' || this.confirmEach) return { action: 'needs-qty', item, step, mode };
    return this.applyQty(item, step, mode);
  }

  async applyQty(item, qty, mode = this.mode, { jobRef = null, note = null } = {}) {
    const amount = Math.abs(Number(qty) || 0);
    if (!amount) throw new Error('Enter a quantity');
    const delta = mode === 'remove' ? -amount : amount;
    const { item: updated, txn } = await applyStockChange({
      itemId: item.id, delta, type: mode === 'remove' ? 'out' : 'in', source: 'scan', jobRef, note,
    });
    if (jobRef) pushJob(jobRef);
    this.pending = { txn, item: updated, before: item.qty, after: updated.qty, mode, qty: amount, at: Date.now() };
    return { action: 'applied', ...this.pending, step: amount };
  }

  async undoPending() {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    const r = await undoTxn(p.txn.id);
    return { ...r, before: p.before };
  }

  /** Change the pending card's amount (0 = undo). */
  async amendPending(newQty) {
    const p = this.pending;
    if (!p) return null;
    const amount = Math.max(0, Number(newQty) || 0);
    if (amount === 0) { await this.undoPending(); return null; }
    const delta = p.mode === 'remove' ? -amount : amount;
    const { item, txn } = await amendTxn(p.txn.id, delta);
    this.pending = { ...p, txn, item, after: item.qty, qty: amount };
    return this.pending;
  }

  nudgePending(dir) {
    if (!this.pending) return Promise.resolve(null);
    const unitStep = this.pending.item.unit === 'ft' ? 5 : 1;
    return this.amendPending(this.pending.qty + dir * unitStep);
  }

  async setPendingJob(jobRef, note) {
    if (!this.pending) return;
    this.pending.txn = await updateTxnMeta(this.pending.txn.id, { jobRef, note });
    if (jobRef) await pushJob(jobRef);
  }

  clearPending() { this.pending = null; }
}
