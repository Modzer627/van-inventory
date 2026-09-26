// Insights: analytics over the movement ledger. Single-series marks in the app
// accent, values in ink tokens, one meter per ranked row, hover tooltips on bars.
import { metaGet } from '../db.js';
import { allParts, displayName } from '../items.js';
import { codesByItem } from '../barcodes.js';
import { allLocations, locationMap, labelOf, UNASSIGNED_KEY } from '../locations.js';
import { allTxns } from '../txns.js';
import { latestCommitted, daysToQuarterEnd, quarterLabel, quarterStart } from '../counts.js';
import { tiles, weeklyUsage, topParts, usageByType, reorderList, deadStock, returnAging, busiestLocations, needsVerification, activitySince } from '../analytics.js';
import { barChart, meter, wireCharts } from '../charts.js';
import { exportInventoryXlsx } from '../export.js';
import { esc, fmtQty, fmtDate, agoLabel, toast, pluralize } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-insights');
let topDays = 30;

const partRow = (item, sub, right) => `
  <div class="rev-row" data-part="${item.id}" style="cursor:pointer">
    <div class="rev-main">${esc(displayName(item))}<div class="txn-sub">${sub}</div></div>
    <div class="rev-nums">${right}</div>
  </div>`;

async function render() {
  const sec = section();
  const [items, codes, locs, txns, lastCount, firstTxnAt] = await Promise.all([
    allParts(), codesByItem(), allLocations(), allTxns(), latestCommitted(), metaGet('firstTxnAt', null),
  ]);
  const map = locationMap(locs);
  const t = tiles({ items, txns });
  const act = activitySince(txns, quarterStart());
  const days = daysToQuarterEnd();
  const reorder = reorderList(items, txns);
  const weeklyEa = weeklyUsage(txns, { weeks: 12, unit: 'ea' });
  const weeklyFt = weeklyUsage(txns, { weeks: 12, unit: 'ft' });
  const top = topParts(items, txns, { days: topDays, unit: 'ea', limit: 8 });
  const topFt = topParts(items, txns, { days: topDays, unit: 'ft', limit: 5 });
  const byType = usageByType(items, txns, { days: 90 });
  const busiest = busiestLocations(txns, locs, { days: 90 });
  const ret = returnAging(items, txns);
  const dead = deadStock(items, txns, { days: 180, firstTxnAt });
  const verify = needsVerification(items, codes);
  const maxTop = top.length ? top[0].qty : 0;
  const maxType = byType.length ? byType[0].qty : 0;
  const maxBusy = busiest.length ? Math.max(...busiest.map(b => b.events)) : 0;

  sec.innerHTML = `
    <header class="hdr">
      <h1>Insights<span class="sub">your van · ${esc(quarterLabel())}</span></h1>
      <button class="icon-btn" data-settings aria-label="Settings">⚙️</button>
    </header>
    <div class="content">
      <div class="tiles">
        <div class="tile"><div class="tile-v">${t.parts}</div><div class="tile-l">parts tracked${t.inReturn ? ` · ${t.inReturn} in Return` : ''}</div></div>
        <div class="tile"><div class="tile-v">${fmtQty(t.unitsEa)}</div><div class="tile-l">pieces on the van${t.unitsFt ? ` · ${fmtQty(t.unitsFt)} ft wire` : ''}</div></div>
        <div class="tile"><div class="tile-v${t.low ? ' bad' : ' good'}">${t.low}</div><div class="tile-l">at or below minimum${t.negative ? ` · <span style="color:var(--danger)">${t.negative} below zero</span>` : ''}</div></div>
        <div class="tile"><div class="tile-v">${days}<span style="font-size:13px;font-weight:600"> days</span></div><div class="tile-l">to quarter end · ${lastCount ? `last count ${esc(lastCount.label)} (${agoLabel(lastCount.committedAt)})` : 'no count yet'}</div></div>
      </div>
      <div class="txn-sub" style="margin:4px 2px 0">This quarter: ${act.removals} removals (${fmtQty(act.unitsEa)} pcs${act.unitsFt ? `, ${fmtQty(act.unitsFt)} ft` : ''}) · ${act.additions} additions · ${act.moves} moves</div>

      <div class="section-title">Reorder <span class="grow"></span>${reorder.length ? `<button class="btn btn-sm" data-export>Excel</button>` : ''}</div>
      ${reorder.length ? reorder.slice(0, 10).map(r => partRow(r.item,
        `${esc(labelOf(r.item.locationId, map))} · ${fmtQty(r.item.qty)} ${r.item.unit === 'ft' ? 'ft' : 'pcs'}${r.item.min ? ` · min ${fmtQty(r.item.min)}` : ''}${r.perDay ? ` · ~${fmtQty(r.perDay * 7)}/wk` : ''}`,
        `<b>order ${r.suggested}</b>${r.daysLeft !== null ? `<div class="txn-sub">${r.daysLeft > 365 ? '1 yr+' : r.daysLeft + ' d'} left</div>` : ''}`)).join('') +
        (reorder.length > 10 ? `<div class="txn-sub" style="margin-top:6px">…and ${reorder.length - 10} more · <button class="btn-ghost" data-tolow style="padding:0;min-height:0;font-size:12.5px">see all low</button></div>` : '')
        : '<div class="chart-empty">Nothing needs reordering. Set a minimum on parts you never want to run out of and they will show up here.</div>'}

      <div class="section-title">Parts used per week <span class="txn-sub" style="text-transform:none;letter-spacing:0">(12 weeks, pieces)</span></div>
      ${barChart(weeklyEa, { unit: 'pcs', emptyText: 'No removals recorded yet — scan parts off the van and this fills in.' })}
      ${weeklyFt.some(w => w.value > 0) ? `<div class="section-title">Wire used per week <span class="txn-sub" style="text-transform:none;letter-spacing:0">(feet)</span></div>${barChart(weeklyFt, { unit: 'ft' })}` : ''}

      <div class="section-title">Most used
        <span class="grow"></span>
        <span class="seg-mini">${[30, 90].map(d => `<button data-topdays="${d}" class="${topDays === d ? 'on' : ''}">${d}d</button>`).join('')}</span>
      </div>
      ${top.length ? top.map(r => `
        <div class="rev-row" ${r.item ? `data-part="${r.item.id}" style="cursor:pointer"` : ''}>
          <div class="rev-main">${esc(r.item ? displayName(r.item) : r.label)}${meter(r.qty, maxTop)}</div>
          <div class="rev-nums">${fmtQty(r.qty)} pcs<div class="txn-sub">${r.events} removals</div></div>
        </div>`).join('') : `<div class="chart-empty">Nothing removed in the last ${topDays} days.</div>`}
      ${topFt.length ? `<div class="txn-sub" style="margin:8px 2px 0">Wire: ${topFt.map(r => `${esc(r.item ? displayName(r.item) : r.label)} ${fmtQty(r.qty)} ft`).join(' · ')}</div>` : ''}

      ${byType.length ? `
        <div class="section-title">By type <span class="txn-sub" style="text-transform:none;letter-spacing:0">(90 days, pieces)</span></div>
        ${byType.slice(0, 8).map(r => `<div class="rev-row"><div class="rev-main">${esc(r.type)}${meter(r.qty, maxType)}</div><div class="rev-nums">${fmtQty(r.qty)}<div class="txn-sub">${r.events} removals</div></div></div>`).join('')}` : ''}

      ${busiest.length ? `
        <div class="section-title">Busiest locations <span class="txn-sub" style="text-transform:none;letter-spacing:0">(90 days)</span></div>
        ${busiest.map(b => `<div class="rev-row"><div class="rev-main">${esc(b.key === UNASSIGNED_KEY ? 'Unassigned' : labelOf(b.key, map))}${meter(b.events, maxBusy)}</div><div class="rev-nums">${b.events} in/out${b.moves ? `<div class="txn-sub">${b.moves} moved here</div>` : ''}</div></div>`).join('')}` : ''}

      <div class="section-title">Return pile ${ret.length ? `<span class="count-badge">${ret.length}</span>` : ''}</div>
      ${ret.length ? ret.map(r => partRow(r.item, `${fmtQty(r.item.qty)} ${r.item.unit === 'ft' ? 'ft' : 'pcs'} · since ${fmtDate(r.sinceTs)}`, `<span class="${r.days > 30 ? 'rev-diff neg' : 'rev-diff zero'}">${r.days} d</span>`)).join('') : '<div class="chart-empty">Nothing waiting to go back.</div>'}

      <div class="section-title">Not used in 180 days</div>
      ${dead.enough
        ? (dead.rows.length ? dead.rows.slice(0, 15).map(r => partRow(r.item, `${esc(labelOf(r.item.locationId, map))} · ${fmtQty(r.item.qty)} ${r.item.unit === 'ft' ? 'ft' : 'pcs'}`, `<span class="rev-diff zero">${r.idleDays} d</span>`)).join('') + (dead.rows.length > 15 ? `<div class="txn-sub" style="margin-top:6px">…and ${dead.rows.length - 15} more</div>` : '') : '<div class="chart-empty">Every stocked part has moved in the last 180 days.</div>')
        : `<div class="chart-empty">Needs 180 days of history to be meaningful — ${dead.historyDays} so far.</div>`}

      ${verify.length ? `
        <div class="section-title">Needs a look <span class="count-badge">${verify.length}</span></div>
        ${verify.slice(0, 20).map(r => partRow(r.item, esc(r.reasons.join(' · ')), `<span class="shelf-badge muted">${esc(map.get(r.item.locationId)?.code || '—')}</span>`)).join('')}
        ${verify.length > 20 ? `<div class="txn-sub" style="margin-top:6px">…and ${verify.length - 20} more · <button class="btn-ghost" data-toverify style="padding:0;min-height:0;font-size:12.5px">see all</button></div>` : ''}` : ''}
    </div>`;

  wireCharts(sec);
  sec.querySelector('[data-settings]').addEventListener('click', () => nav.show('settings'));
  sec.querySelectorAll('[data-topdays]').forEach(b => b.addEventListener('click', () => { topDays = Number(b.dataset.topdays); render(); }));
  sec.querySelectorAll('[data-part]').forEach(r => r.addEventListener('click', () => nav.show('part', { id: r.dataset.part })));
  sec.querySelector('[data-tolow]')?.addEventListener('click', () => nav.showTab('parts', { filter: 'low' }));
  sec.querySelector('[data-toverify]')?.addEventListener('click', () => nav.showTab('parts', { filter: 'verify' }));
  sec.querySelector('[data-export]')?.addEventListener('click', async () => {
    const r = await exportInventoryXlsx({ items, codesByItem: codes, locations: locs, txns, period: { sinceTs: quarterStart(), label: 'this quarter' } });
    if (r === 'shared' || r === 'downloaded') toast(`Exported — the Low stock sheet lists ${pluralize(reorder.length, 'part')}`);
  });
}

export default { show: render, refresh: render };
