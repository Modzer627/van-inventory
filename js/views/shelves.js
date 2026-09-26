// Shelves tab: the van map (left side / right side / elsewhere).
import { allParts } from '../items.js';
import { allLocations, tree, bySide, statsByLocation, SIDE_LABEL, RET_ID, UNASSIGNED_KEY } from '../locations.js';
import { esc, fmtQty, pluralize } from '../ui.js';
import * as nav from '../nav.js';

const section = () => document.getElementById('screen-shelves');

function tile(node, stats, child = false) {
  const l = node.loc;
  const s = stats.get(l.id) || { count: 0, low: 0, ea: 0, ft: 0 };
  const kids = node.children.map(c => tile(c, stats, true)).join('');
  return `
    <button class="loc-card${child ? ' child' : ''}${l.kind === 'pile' ? ' pile' : ''}" data-loc="${esc(l.id)}">
      <div class="lc-name">${esc(l.name)}${l.tag ? `<span class="lc-tag">${esc(l.tag)}</span>` : ''}${l.kind === 'floor' ? '<span class="lc-tag">floor</span>' : ''}</div>
      <div class="lc-n">${s.count}<small>${s.count === 1 ? 'part' : 'parts'}</small></div>
      <div class="lc-sub">
        ${s.low ? `<span class="badge-low">${s.low} low</span>` : ''}
        ${s.ea ? `<span>${fmtQty(s.ea)} pcs</span>` : ''}${s.ft ? `<span>${fmtQty(s.ft)} ft</span>` : ''}
      </div>
    </button>${kids}`;
}

async function render() {
  const sec = section();
  const [items, locs] = await Promise.all([allParts(), allLocations()]);
  const stats = statsByLocation(items);
  const sides = bySide(tree(locs));
  const unassigned = stats.get(UNASSIGNED_KEY) || { count: 0, low: 0 };
  const retNode = sides.none.find(n => n.loc.id === RET_ID);
  const otherNone = sides.none.filter(n => n.loc.id !== RET_ID);

  sec.innerHTML = `
    <header class="hdr">
      <h1>Shelves<span class="sub">${pluralize(items.length, 'part')} across ${pluralize(locs.filter(l => l.id !== RET_ID).length, 'location')}</span></h1>
      <button class="icon-btn" data-manage aria-label="Manage locations">✎</button>
    </header>
    <div class="content">
      <div class="van-map">
        <div class="van-col"><h3>${SIDE_LABEL.left}</h3>${sides.left.map(n => tile(n, stats)).join('') || '<div class="txn-sub">No shelves</div>'}</div>
        <div class="van-col"><h3>${SIDE_LABEL.right}</h3>${sides.right.map(n => tile(n, stats)).join('') || '<div class="txn-sub">No shelves</div>'}</div>
      </div>
      <div class="section-title">Elsewhere</div>
      ${otherNone.map(n => tile(n, stats)).join('')}
      ${retNode ? tile(retNode, stats) : ''}
      <button class="loc-card pile" data-loc="${UNASSIGNED_KEY}">
        <div class="lc-name">Unassigned</div>
        <div class="lc-n">${unassigned.count}<small>${unassigned.count === 1 ? 'part' : 'parts'}</small></div>
        <div class="lc-sub">${unassigned.count ? 'No shelf recorded yet — open to file them' : 'Everything has a home'}</div>
      </button>
    </div>`;

  sec.querySelector('[data-manage]').addEventListener('click', () => nav.show('locations'));
  sec.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', () => nav.show('shelf', { id: b.dataset.loc })));
}

export default { show: render, refresh: render };
