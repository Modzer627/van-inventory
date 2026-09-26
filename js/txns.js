// Ledger queries, undo (compensating rows), recent job names.
import { dbAll, dbAllByIndex, dbGet, dbPut, metaGet, metaSet, applyStockChange } from './db.js';

/** Rows that should show in history / analytics: not undone, not an undo itself. */
export const visible = (t) => !t.voided && !t.reverses;
export const isUsage = (t) => t.type === 'out' && visible(t);

export async function itemHistory(itemId, limit = 60) {
  const rows = await dbAllByIndex('txns', 'itemId', itemId);
  rows.sort((a, b) => b.ts - a.ts);
  return rows.filter(visible).slice(0, limit);
}

export async function allTxns() {
  const rows = await dbAll('txns');
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
}

export async function txnsSince(ts) {
  const rows = await dbAllByIndex('txns', 'ts', IDBKeyRange.lowerBound(ts));
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
}

export const getTxn = (id) => dbGet('txns', id);

/** Reverse a movement with a compensating row; the original is marked voided. */
export async function undoTxn(txnId, { note = 'Undo' } = {}) {
  const txn = await dbGet('txns', txnId);
  if (!txn) throw new Error('Movement not found');
  if (txn.voided) throw new Error('Already undone');
  if (txn.type === 'move') {
    return applyStockChange({ itemId: txn.itemId, type: 'move', toLoc: txn.fromLoc ?? null, note, source: 'undo', reverses: txn.id });
  }
  return applyStockChange({
    itemId: txn.itemId, delta: -txn.delta, type: txn.type, note, jobRef: null,
    source: 'undo', reverses: txn.id, countId: txn.countId || null,
  });
}

/** Replace a movement's amount: undo it, then write the new amount. Returns the new row. */
export async function amendTxn(txnId, newDelta, { note, jobRef } = {}) {
  const orig = await dbGet('txns', txnId);
  if (!orig) throw new Error('Movement not found');
  if (!orig.voided) await undoTxn(txnId, { note: 'Amended' });
  return applyStockChange({
    itemId: orig.itemId, delta: newDelta, type: orig.type,
    note: note !== undefined ? note : orig.note, jobRef: jobRef !== undefined ? jobRef : orig.jobRef,
    source: orig.source === 'undo' ? 'manual' : orig.source,
  });
}

export async function updateTxnMeta(id, { jobRef, note }) {
  const txn = await dbGet('txns', id);
  if (!txn) throw new Error('Movement not found');
  if (jobRef !== undefined) txn.jobRef = jobRef || null;
  if (note !== undefined) txn.note = note || null;
  await dbPut('txns', txn);
  return txn;
}

const MAX_RECENT_JOBS = 10;

export function recentJobs() {
  return metaGet('recentJobs', []);
}

export async function pushJob(name) {
  const job = (name || '').trim();
  if (!job) return;
  const jobs = await recentJobs();
  const next = [job, ...jobs.filter(j => j.toLowerCase() !== job.toLowerCase())].slice(0, MAX_RECENT_JOBS);
  await metaSet('recentJobs', next);
}

export const TYPE_LABEL = { in: 'Added', out: 'Removed', set: 'Set qty', count: 'Counted', move: 'Moved', import: 'Imported' };
export const TYPE_ICON = { in: '+', out: '−', set: '≡', count: '✓', move: '⇄', import: '⇩' };
