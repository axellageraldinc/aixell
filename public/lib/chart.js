// Small SVG bar chart: tokens per day. A value above every bar while there is room, a token scale on the left,
// date labels only at first, last and peak; tooltips via <title>.
import { svgEl } from './icons.js';
import { fmtCompact, fmtDay, fmtInt, fmtMoney } from './format.js';
import { t } from './i18n.js';

const W = 368;
const H = 120;
const LABEL_H = 16;
const PAD_L = 40;
const TOP = 16;
const VALUE_LABEL_MAX_DAYS = 12;
const MIN_LABEL_GAP = 44;

export function barChart(days, currency = 'USD') {
  const totals = days.map((d) => (d.inputTokens ?? 0) + (d.outputTokens ?? 0));
  const peak = totals.indexOf(Math.max(...totals));
  const max = Math.max(1, ...totals);
  const plotH = H - LABEL_H;
  const slot = (W - PAD_L) / days.length;
  const barW = Math.max(1, slot - 2);

  const svg = svgEl('svg', { class: 'bar-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('usage.chart.label') });
  svg.append(svgEl('line', { class: 'axis', x1: PAD_L, x2: W, y1: plotH + 0.5, y2: plotH + 0.5 }));
  for (const frac of [0.5, 1]) {
    const y = plotH - frac * (plotH - TOP);
    svg.append(svgEl('line', { class: 'grid', x1: PAD_L, x2: W, y1: y.toFixed(1), y2: y.toFixed(1) }));
    const scale = svgEl('text', { class: 'axis-label', x: PAD_L - 4, y: (y + 4).toFixed(1), 'text-anchor': 'end' });
    scale.textContent = fmtCompact(Math.round(max * frac));
    svg.append(scale);
  }

  days.forEach((d, i) => {
    const barH = (totals[i] / max) * (plotH - TOP);
    const x = PAD_L + i * slot + (slot - barW) / 2;
    const bar = svgEl('rect', { class: 'bar', x: x.toFixed(1), y: (plotH - barH).toFixed(1), width: barW.toFixed(1), height: barH.toFixed(1) });
    const tip = svgEl('title', {});
    tip.textContent = `${fmtDay(d.date)}: ${fmtInt(totals[i])} tokens, ${fmtInt(d.apiCalls)} calls, ${fmtMoney(d.estimatedCost, currency)}`;
    bar.append(tip);
    svg.append(bar);
    if (days.length <= VALUE_LABEL_MAX_DAYS && totals[i] > 0) {
      const value = svgEl('text', { class: 'axis-label bar-value', x: (x + barW / 2).toFixed(1), y: (plotH - barH - 4).toFixed(1), 'text-anchor': 'middle' });
      value.textContent = fmtCompact(totals[i]);
      svg.append(value);
    }
  });

  // First and last win over the peak when labels would collide.
  const placed = [];
  for (const i of new Set([0, days.length - 1, peak])) {
    const cx = PAD_L + i * slot + slot / 2;
    if (placed.some((p) => Math.abs(p - cx) < MIN_LABEL_GAP)) continue;
    placed.push(cx);
    const anchor = i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle';
    const label = svgEl('text', { class: 'axis-label', x: (anchor === 'start' ? PAD_L : anchor === 'end' ? W : cx).toFixed(1), y: H - 3, 'text-anchor': anchor });
    label.textContent = fmtDay(days[i].date);
    svg.append(label);
  }
  return svg;
}
