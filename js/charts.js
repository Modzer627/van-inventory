// Minimal chart kit (no libraries). Single-series marks in the app accent;
// all text in ink tokens; per-mark tooltips; theme-aware via CSS variables.
import { esc, fmtQty } from './ui.js';

/**
 * Vertical bar chart. series: [{label, value, hint}]
 * Returns an HTML string; call wireCharts(container) after inserting.
 */
export function barChart(series, { height = 150, unit = '', emptyText = 'No usage recorded yet for this period.' } = {}) {
  if (!series.length || series.every(s => s.value === 0)) {
    return `<div class="chart-empty">${esc(emptyText)}</div>`;
  }
  const W = 560, H = height, padL = 6, padB = 20, padT = 16;
  const plotH = H - padB - padT;
  const max = Math.max(...series.map(s => s.value)) || 1;
  const n = series.length;
  const slot = (W - padL * 2) / n;
  const barW = Math.max(6, Math.min(34, slot - 2));
  const maxIdx = series.findIndex(s => s.value === max);

  const grid = [0.5, 1].map(f =>
    `<line x1="${padL}" y1="${padT + plotH * (1 - f)}" x2="${W - padL}" y2="${padT + plotH * (1 - f)}" class="ch-grid"/>`
  ).join('');

  const bars = series.map((s, i) => {
    const h = Math.max(s.value > 0 ? 3 : 0, (s.value / max) * plotH);
    const x = padL + i * slot + (slot - barW) / 2;
    const y = padT + plotH - h;
    const r = Math.min(4, barW / 2, h);
    const path = h === 0 ? '' :
      `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + h} Z`;
    const label = (i === maxIdx || i === n - 1) && s.value > 0
      ? `<text x="${x + barW / 2}" y="${y - 4}" class="ch-val" text-anchor="middle">${fmtQty(s.value)}</text>` : '';
    const tip = `${esc(s.hint || s.label)}: ${fmtQty(s.value)}${unit ? ' ' + esc(unit) : ''}`;
    return `<g class="ch-bar" data-tip="${tip}">
      <rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH + padB}" fill="transparent"/>
      ${path ? `<path d="${path}" class="ch-fill"/>` : ''}
      ${label}
    </g>`;
  }).join('');

  const ticks = series.map((s, i) => {
    const every = Math.ceil(n / 8);
    if (i % every !== 0 && i !== n - 1) return '';
    return `<text x="${padL + i * slot + slot / 2}" y="${H - 5}" class="ch-tick" text-anchor="middle">${esc(s.label)}</text>`;
  }).join('');

  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${bars}${ticks}</svg></div>`;
}

/** Inline meter for table rows. */
export function meter(value, max) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return `<div class="meter"><div style="width:${pct}%"></div></div>`;
}

/** One shared tooltip for all charts inside `root`. */
export function wireCharts(root) {
  let tip = document.querySelector('.ch-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'ch-tooltip';
    document.body.appendChild(tip);
  }
  const show = (target, x, y) => {
    tip.textContent = target.dataset.tip;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(6, Math.min(x - r.width / 2, window.innerWidth - r.width - 6)) + 'px';
    tip.style.top = Math.max(6, y - r.height - 12) + 'px';
  };
  const hide = () => { tip.style.display = 'none'; };
  root.querySelectorAll('.ch-bar').forEach(g => {
    g.addEventListener('pointerenter', (e) => show(g, e.clientX, e.clientY));
    g.addEventListener('pointermove', (e) => show(g, e.clientX, e.clientY));
    g.addEventListener('pointerleave', hide);
    g.addEventListener('pointerdown', (e) => { show(g, e.clientX, e.clientY); setTimeout(hide, 1800); });
  });
}
