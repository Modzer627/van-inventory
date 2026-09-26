// Count tab: start a count, walk it location by location, review, commit; history + compare.
import { dbGet } from '../db.js';
import { allParts, isLow, displayName } from '../items.js';
import { allLocations, locationMap, labelOf, tree, bySide, SIDE_LABEL, RET_ID, UNASSIGNED_KEY } from '../locations.js';
import { allTxns } from '../txns.js';
import { openCount, startCount, saveCount, discardCount, setLine, tally, clearLine, itemsAt, progress, progressAt, buildReview, commitCount, committedCounts, suggestLabel, quarterLabel, daysToQuarterEnd, countedThisQuarter, compareSnapshots } from '../counts.js';
import { exportCountXlsx } from '../export.js';
import { esc, fmtQty, fmtDate, fmtDateTime, toast, confirmDialog, sheet, pluralize } from '../ui.js';
import * as nav from '../nav.js';

const secCount = () => document.getElementById('screen-count');
const secReview = () => document.getElementById('screen-count-review');
const secDetail = () => document.getElementById('screen-count-detail');

const unitWord = (i) => (i.unit === 'ft' ? 'ft' : 'pcs');
let uncountedOnly = false;
let zeroUncounted = false;

/* ================= count root ================= */
async function renderRoot() {
  const rec = await openCount();
  if (rec) return renderWalk(rec);
  return renderStart();
}

async function renderStart() {
  const sec = secCount();
  const [locs, history, label, done, items] = await Promise.all([allLocations(), committedCounts(), suggestLabel(), countedThisQuarter(), allParts()]);
  const map = locationMap(locs);
  const days = daysToQuarterEnd();
  const sides = bySide(tree(locs));
  const row = (node, child = false) => `
    <label class="pick-row${child ? ' child' : ''}" style="cursor:pointer">
      <input type="checkbox" data-scope-loc="${esc(node.loc.id)}" checked style="width:20px;height:20px;accent-color:var(--accent)">
      <span class="grow">${esc(node.loc.name)}</span><span class="shelf-badge">${esc(node.loc.code)}</span>
    </label>${node.children.map(c => row(c, true)).join('')}`;

  sec.innerHTML = `
    <header class="hdr">
      <h1>Count<span class="sub">quarterly inventory · ${esc(quarterLabel())}</span></h1>
      <button class="icon-btn" data-settings aria-label="Settings">⚙️</button>
    </header>
    <div class="content">
      ${!done && days <= 14 ? `<div class="banner">${esc(quarterLabel())} ends in ${pluralize(days, 'day')} and no count is committed yet.</div>` : ''}
      ${done ? `<div class="banner info">✓ ${esc(quarterLabel())} count is done. Start another any time.</div>` : ''}
      ${!items.length ? '<div class="banner info">Import your spreadsheet first (Settings → Import) so there is something to count.</div>' : ''}
      <div class="set-group">
        <div class="set-row"><div class="grow">Count name</div><input type="text" data-label value="${esc(label)}" style="max-width:170px"></div>
        <div class="set-row" style="flex-direction:column;align-items:stretch;gap:10px">
          <div class="seg-page"><button data-scope="all" class="on">Whole van</button><button data-scope="pick">Pick shelves</button></div>
          <div data-scope-list hidden>
            ${['left', 'right'].map(side => sides[side].length ? `<div class="section-title" style="margin-top:4px">${SIDE_LABEL[side]}</div>${sides[side].map(n => row(n)).join('')}` : '').join('')}
            <label class="pick-row" style="cursor:pointer"><input type="checkbox" data-scope-loc="${UNASSIGNED_KEY}" checked style="width:20px;height:20px;accent-color:var(--accent)"><span class="grow">Unassigned</span><span class="shelf-badge muted">—</span></label>
          </div>
        </div>
        <div class="set-row"><div class="grow">Include the Return pile<span class="hint">Usually skipped — it is not stock</span></div><label class="switch"><input type="checkbox" data-incret><span></span></label></div>
        <div class="set-row"><div class="grow">Note</div><input type="text" data-note placeholder="optional" style="max-width:170px"></div>
      </div>
      <button class="btn btn-block btn-primary" data-start ${items.length ? '' : 'disabled'}>Start count</button>

      <div class="section-title" style="margin-top:24px">Past counts</div>
      ${history.length ? history.map(c => `
        <button class="pick-row" data-detail="${c.id}">
          <span class="grow">${esc(c.label)}<span class="sub">${fmtDate(c.committedAt)} · ${c.stats ? `${c.stats.counted} counted · ${c.stats.adjusted} adjusted` : ''}</span></span>
          <span>›</span>
        </button>`).join('') : '<div class="empty">No counts committed yet.</div>'}
    </div>`;

  sec.querySelector('[data-settings]').addEventListener('click', () => nav.show('settings'));
  let scope = 'all';
  sec.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => {
    scope = b.dataset.scope;
    sec.querySelectorAll('[data-scope]').forEach(x => x.classList.toggle('on', x === b));
    sec.querySelector('[data-scope-list]').hidden = scope !== 'pick';
  }));
  sec.querySelectorAll('[data-detail]').forEach(b => b.addEventListener('click', () => nav.show('count-detail', { id: b.dataset.detail })));
  sec.querySelector('[data-start]').addEventListener('click', async () => {
    const lbl = sec.querySelector('[data-label]').value.trim() || label;
    const includeReturn = sec.querySelector('[data-incret]').checked;
    const note = sec.querySelector('[data-note]').value.trim();
    const picked = [...sec.querySelectorAll('[data-scope-loc]:checked')].map(i => i.dataset.scopeLoc);
    try {
      await startCount({ label: lbl, scope: scope === 'all' ? { all: true } : { locationIds: picked }, includeReturn, note });
      uncountedOnly = false;
      renderRoot();
    } catch (e) { toast(e.message, { error: true }); }
  });
  void map;
}

async function renderWalk(rec) {
  const sec = secCount();
  const [items, locs] = await Promise.all([allParts(), allLocations()]);
  const map = locationMap(locs);
  const idx = Math.max(0, rec.order.indexOf(rec.cursor));
  const key = rec.order[idx] || rec.order[0];
  if (key !== rec.cursor) { rec.cursor = key; await saveCount(rec); }
  const here = itemsAt(items, key);
  const shown = uncountedOnly ? here.filter(i => !rec.lines[i.id]) : here;
  const total = progress(rec, items);
  const local = progressAt(rec, items, key);
  const locName = key === UNASSIGNED_KEY ? 'Unassigned' : labelOf(key, map);
  const review = buildReview(rec, items);

  sec.innerHTML = `
    <header class="hdr">
      <h1>${esc(rec.label)}<span class="sub">started ${fmtDateTime(rec.startedAt)} · ${total.counted} of ${total.total} counted</span></h1>
      <button class="icon-btn" data-menu aria-label="More">⋯</button>
    </header>
    <div class="content">
      <div class="progressbar" style="margin:0 0 12px"><div style="width:${total.pct}%"></div></div>
      <div class="pager">
        <button class="icon-btn" data-prev ${idx === 0 ? 'disabled' : ''} aria-label="Previous location">◀</button>
        <div class="mid">${esc(locName)}<span class="sub">${idx + 1} of ${rec.order.length} · ${local.counted}/${local.total} here</span></div>
        <button class="icon-btn" data-next ${idx >= rec.order.length - 1 ? 'disabled' : ''} aria-label="Next location">▶</button>
      </div>
      <div class="filters">
        <button class="chip${uncountedOnly ? '' : ' on'}" data-show="all">All here (${here.length})</button>
        <button class="chip${uncountedOnly ? ' on' : ''}" data-show="left">Not counted (${here.length - local.counted})</button>
      </div>
      ${shown.length ? shown.map(i => {
        const line = rec.lines[i.id];
        return `
          <div class="st-row${line ? ' counted' : ''}" data-id="${i.id}">
            <div class="st-main" data-open>
              <div class="item-name"><span class="brand">${esc(i.brand)}</span> ${esc(i.model)}</div>
              <div class="st-expected">Expected ${fmtQty(i.qty)} ${unitWord(i)}${i.type ? ` · ${esc(i.type)}` : ''}${line && line.locationKey !== key ? ' · counted elsewhere' : ''}</div>
            </div>
            <button class="st-ok" data-match title="Matches expected">✓</button>
            <input type="text" inputmode="decimal" data-count value="${line ? esc(fmtQty(line.counted)) : ''}" placeholder="${esc(fmtQty(i.qty))}" aria-label="Counted">
            <button class="st-plus" data-plus>+1</button>
          </div>`;
      }).join('') : `<div class="empty">${here.length ? 'Everything here is counted ✓' : 'Nothing is filed here — scan anything you find and it will be added.'}</div>`}
      ${idx < rec.order.length - 1 ? '<button class="btn btn-block" data-nextbig style="margin-top:8px">Next location ▶</button>' : '<button class="btn btn-block btn-primary" data-reviewbig style="margin-top:8px">All done — review</button>'}
    </div>
    <div class="actionbar">
      <button class="btn btn-primary" data-scan><span class="ico">📷</span>Scan &amp; count</button>
      <button class="btn" data-review><span class="ico">📋</span>Review${review.variances ? ` (${review.variances})` : ''}</button>
    </div>`;

  const go = async (delta) => { rec.cursor = rec.order[Math.min(rec.order.length - 1, Math.max(0, idx + delta))]; await saveCount(rec); renderWalk(rec); };
  sec.querySelector('[data-prev]').addEventListener('click', () => go(-1));
  sec.querySelector('[data-next]').addEventListener('click', () => go(1));
  sec.querySelector('[data-nextbig]')?.addEventListener('click', () => go(1));
  sec.querySelector('[data-reviewbig]')?.addEventListener('click', () => nav.show('count-review'));
  sec.querySelectorAll('[data-show]').forEach(b => b.addEventListener('click', () => { uncountedOnly = b.dataset.show === 'left'; renderWalk(rec); }));
  sec.querySelector('[data-scan]').addEventListener('click', () => nav.show('scan', { count: true, key }));
  sec.querySelector('[data-review]').addEventListener('click', () => nav.show('count-review'));
  sec.querySelector('[data-menu]').addEventListener('click', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <button class="btn btn-block" data-pause style="margin-bottom:10px">Pause — continue later</button>
      <button class="btn btn-block" data-export style="margin-bottom:10px">Review so far</button>
      <button class="btn btn-block" data-discard style="color:var(--danger)">Discard this count</button>`;
    const s = sheet({ title: rec.label, content: wrap });
    wrap.querySelector('[data-pause]').addEventListener('click', () => { s.close(); nav.showTab('parts'); });
    wrap.querySelector('[data-export]').addEventListener('click', () => { s.close(); nav.show('count-review'); });
    wrap.querySelector('[data-discard]').addEventListener('click', async () => {
      s.close();
      const yes = await confirmDialog('Discard this count? Nothing you counted will be applied.', { danger: true, okLabel: 'Discard' });
      if (!yes) return;
      await discardCount(rec);
      toast('Count discarded');
      renderRoot();
    });
  });

  sec.querySelectorAll('.st-row').forEach(row => {
    const item = items.find(i => i.id === row.dataset.id);
    const input = row.querySelector('[data-count]');
    const save = async (val) => {
      if (val === '' || val === null) clearLine(rec, item.id);
      else setLine(rec, item, Math.max(0, Number(String(val).replace(',', '.')) || 0), key);
      await saveCount(rec);
      row.classList.toggle('counted', !!rec.lines[item.id]);
      refreshHeader(rec, items, sec, key);
    };
    row.querySelector('[data-open]').addEventListener('click', () => nav.show('part', { id: item.id }));
    row.querySelector('[data-match]').addEventListener('click', () => { input.value = fmtQty(item.qty); save(item.qty); });
    row.querySelector('[data-plus]').addEventListener('click', async () => { const n = tally(rec, item, 1, key); input.value = fmtQty(n); await saveCount(rec); row.classList.add('counted'); refreshHeader(rec, items, sec, key); });
    input.addEventListener('change', () => save(input.value.trim()));
    input.addEventListener('focus', () => input.select());
  });
}

function refreshHeader(rec, items, sec, key) {
  const total = progress(rec, items);
  const local = progressAt(rec, items, key);
  const sub = sec.querySelector('.hdr .sub');
  if (sub) sub.textContent = `started ${fmtDateTime(rec.startedAt)} · ${total.counted} of ${total.total} counted`;
  const bar = sec.querySelector('.progressbar div');
  if (bar) bar.style.width = `${total.pct}%`;
  const mid = sec.querySelector('.pager .mid .sub');
  if (mid) mid.textContent = `${rec.order.indexOf(key) + 1} of ${rec.order.length} · ${local.counted}/${local.total} here`;
  const left = sec.querySelector('[data-show="left"]');
  if (left) left.textContent = `Not counted (${local.total - local.counted})`;
}

/* ================= review ================= */
async function renderReview() {
  const sec = secReview();
  const rec = await openCount();
  if (!rec) { nav.back(); return; }
  const [items, locs] = await Promise.all([allParts(), allLocations()]);
  const map = locationMap(locs);
  const review = buildReview(rec, items);
  const changed = review.counted.filter(r => r.diff !== 0);
  const same = review.counted.length - changed.length;

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>Review<span class="sub">${esc(rec.label)} · ${review.counted.length} counted · ${changed.length} differ</span></h1>
    </header>
    <div class="content">
      <div class="tiles">
        <div class="tile"><div class="tile-v">${review.counted.length}</div><div class="tile-l">parts counted</div></div>
        <div class="tile"><div class="tile-v${changed.length ? ' bad' : ' good'}">${changed.length}</div><div class="tile-l">quantities differ</div></div>
        <div class="tile"><div class="tile-v good">${same}</div><div class="tile-l">match</div></div>
        <div class="tile"><div class="tile-v${review.uncounted.length ? ' bad' : ''}">${review.uncounted.length}</div><div class="tile-l">not counted</div></div>
      </div>
      <div class="section-title">Differences</div>
      ${changed.length ? changed.map(r => `
        <div class="rev-row">
          <div class="rev-main">${esc(displayName(r.item))}<div class="txn-sub">${esc(labelOf(r.item.locationId, map))} · ${fmtQty(r.expected)} → ${fmtQty(r.counted)} ${unitWord(r.item)}${r.movedSince ? ' · moved since you counted it' : ''}</div></div>
          <div class="rev-diff ${r.diff > 0 ? 'pos' : 'neg'}">${r.diff > 0 ? '+' : ''}${fmtQty(r.diff)}</div>
        </div>`).join('') : '<div class="chart-empty">Every counted part matches its expected quantity.</div>'}
      ${review.uncounted.length ? `
        <div class="section-title">Not counted (${review.uncounted.length})</div>
        <label class="set-row" style="border:1px solid var(--border);border-radius:14px;background:var(--surface);cursor:pointer;margin-bottom:8px">
          <div class="grow">Set these to zero<span class="hint">Only if you are sure they are not on the van</span></div>
          <span class="switch"><input type="checkbox" data-zero ${zeroUncounted ? 'checked' : ''}><span></span></span>
        </label>
        ${review.uncounted.slice(0, 60).map(i => `<div class="rev-row"><div class="rev-main">${esc(displayName(i))}<div class="txn-sub">${esc(labelOf(i.locationId, map))}</div></div><div class="rev-nums">${fmtQty(i.qty)} ${unitWord(i)}</div></div>`).join('')}
        ${review.uncounted.length > 60 ? `<div class="txn-sub" style="margin-top:6px">…and ${review.uncounted.length - 60} more</div>` : ''}` : ''}
    </div>
    <div class="actionbar">
      <button class="btn" data-continue><span class="ico">↩</span>Keep counting</button>
      <button class="btn btn-primary" data-commit><span class="ico">✓</span>Confirm &amp; update stock</button>
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-continue]').addEventListener('click', () => nav.back());
  sec.querySelector('[data-zero]')?.addEventListener('change', (e) => { zeroUncounted = e.target.checked; });
  sec.querySelector('[data-commit]').addEventListener('click', async () => {
    if (!review.counted.length) { toast('Nothing counted yet', { error: true }); return; }
    const msg = `Apply ${changed.length} quantity change${changed.length === 1 ? '' : 's'}${zeroUncounted && review.uncounted.length ? ` and set ${review.uncounted.length} uncounted parts to zero` : ''}? A snapshot of the whole van is saved with this count.`;
    if (!(await confirmDialog(msg, { okLabel: 'Commit count' }))) return;
    try {
      const committed = await commitCount(rec, { zeroUncounted });
      zeroUncounted = false;
      toast(`Count ${committed.label} committed`);
      nav.show('count-detail', { id: committed.id }, { replace: true });
    } catch (e) { toast(e.message, { error: true, duration: 5000 }); }
  });
}

/* ================= committed count detail ================= */
let detailId = null;
async function renderDetail() {
  const sec = secDetail();
  const rec = await dbGet('counts', detailId);
  if (!rec || !rec.committedAt) { nav.back(); return; }
  const prev = rec.prevCountId ? await dbGet('counts', rec.prevCountId) : null;
  const locs = await allLocations({ includeDeleted: true });
  const map = locationMap(locs);
  const cmp = prev && prev.snapshot ? compareSnapshots(rec, prev) : null;
  const s = rec.stats || {};
  const vars = rec.variances || [];

  sec.innerHTML = `
    <header class="hdr">
      <button class="icon-btn" data-back aria-label="Back">←</button>
      <h1>${esc(rec.label)}<span class="sub">committed ${fmtDateTime(rec.committedAt)}</span></h1>
      <button class="icon-btn" data-export aria-label="Export">⇪</button>
    </header>
    <div class="content">
      <div class="tiles">
        <div class="tile"><div class="tile-v">${s.parts ?? '—'}</div><div class="tile-l">parts on the van</div></div>
        <div class="tile"><div class="tile-v">${s.counted ?? '—'}</div><div class="tile-l">counted</div></div>
        <div class="tile"><div class="tile-v${s.adjusted ? ' bad' : ' good'}">${s.adjusted ?? 0}</div><div class="tile-l">adjusted</div></div>
        <div class="tile"><div class="tile-v">${s.zeroed ?? 0}</div><div class="tile-l">set to zero</div></div>
      </div>
      ${rec.note ? `<div class="banner info">${esc(rec.note)}</div>` : ''}
      <button class="btn btn-block btn-primary" data-export2 style="margin:6px 0 4px">⇪ Export this count (Excel)</button>

      <div class="section-title">Variances (${vars.length})</div>
      ${vars.length ? vars.map(v => `
        <div class="rev-row">
          <div class="rev-main">${esc(v.label)}<div class="txn-sub">${esc(labelOf(v.locationId, map))} · ${fmtQty(v.expected)} → ${fmtQty(v.counted)} ${v.unit === 'ft' ? 'ft' : 'pcs'}</div></div>
          <div class="rev-diff ${v.diff > 0 ? 'pos' : 'neg'}">${v.diff > 0 ? '+' : ''}${fmtQty(v.diff)}</div>
        </div>`).join('') : '<div class="chart-empty">No quantity changes in this count.</div>'}

      ${cmp ? `
        <div class="section-title">Since ${esc(prev.label)} <span class="txn-sub" style="text-transform:none;letter-spacing:0">(${fmtDate(prev.committedAt)})</span></div>
        <div class="tiles">
          <div class="tile"><div class="tile-v">${fmtQty(cmp.totals.ea.prev)} → ${fmtQty(cmp.totals.ea.curr)}</div><div class="tile-l">pieces on the van</div></div>
          <div class="tile"><div class="tile-v">${cmp.changed}</div><div class="tile-l">parts changed · ${cmp.added} new · ${cmp.removed} gone</div></div>
        </div>
        ${cmp.rows.filter(r => r.status !== 'same').slice(0, 40).map(r => `
          <div class="rev-row">
            <div class="rev-main">${esc([r.brand, r.model].filter(Boolean).join(' '))}<div class="txn-sub">${r.status === 'new' ? 'new part' : r.status === 'gone' ? 'no longer tracked' : `${fmtQty(r.prevQty)} → ${fmtQty(r.currQty)} ${r.unit === 'ft' ? 'ft' : 'pcs'}`}</div></div>
            <div class="rev-diff ${r.change > 0 ? 'pos' : r.change < 0 ? 'neg' : 'zero'}">${r.change > 0 ? '+' : ''}${fmtQty(r.change)}</div>
          </div>`).join('') || '<div class="chart-empty">Nothing changed between the two counts.</div>'}` : '<div class="chart-empty" style="margin-top:14px">The next committed count will compare itself with this one.</div>'}
    </div>`;

  sec.querySelector('[data-back]').addEventListener('click', () => nav.back());
  const doExport = async () => {
    const [txns, items] = await Promise.all([allTxns(), allParts({ includeDeleted: true })]);
    const r = await exportCountXlsx({ count: rec, prev, locations: locs, txns, items });
    if (r === 'shared' || r === 'downloaded') toast('Count exported');
  };
  sec.querySelector('[data-export]').addEventListener('click', doExport);
  sec.querySelector('[data-export2]').addEventListener('click', doExport);
}

export const countView = { show: renderRoot, refresh: renderRoot };
export const countReviewView = { show: renderReview, refresh: renderReview };
export const countDetailView = { show(params) { detailId = params.id; return renderDetail(); }, refresh: renderDetail };
export { isLow, RET_ID };
