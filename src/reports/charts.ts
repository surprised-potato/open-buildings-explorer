/** Dependency-free SVG charts for reports. One generator feeds both the in-app preview and the printable export. */

export interface BarItem {
  label: string;
  value: number;
  /** Text shown at the bar end; defaults to the formatted value. */
  display?: string;
  color?: string;
}

export interface StackRow {
  label: string;
  values: number[];
}

export interface ScatterPoint {
  label: string;
  x: number;
  y: number;
}

export type ReportChart =
  | { kind: 'bar'; title: string; items: BarItem[]; highlight?: string; note?: string }
  | { kind: 'donut'; title: string; items: Array<{ label: string; value: number }>; centerLabel?: string; note?: string }
  | {
      kind: 'stack';
      title: string;
      series: string[];
      rows: StackRow[];
      /** true: every row fills the full width (shares); false: shared absolute scale. */
      normalize: boolean;
      note?: string;
    }
  | {
      kind: 'scatter';
      title: string;
      xLabel: string;
      yLabel: string;
      points: ScatterPoint[];
      highlight?: string;
      note?: string;
    };

/** Colour-blind-safe categorical palette, readable on both dark and white backgrounds. */
export const CHART_COLORS = [
  '#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#64748b',
];
const HIGHLIGHT = '#f59e0b';
const W = 560;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (a >= 100) return Math.round(v).toLocaleString('en-PH');
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '') || '0';
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function frame(title: string, h: number, body: string, desc: string): string {
  return `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" font-size="11" fill="currentColor"><title>${esc(title)}</title><desc>${esc(desc)}</desc>${body}</svg>`;
}

function barChart(c: Extract<ReportChart, { kind: 'bar' }>): string {
  const items = c.items.filter((i) => Number.isFinite(i.value)).slice(0, 25);
  if (!items.length) return '';
  const rowH = 20;
  const labelW = 150;
  const valueW = 64;
  const barW = W - labelW - valueW - 8;
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  const body = items
    .map((it, i) => {
      const y = i * rowH + 4;
      const w = Math.max(it.value > 0 ? 1.5 : 0, (Math.max(0, it.value) / max) * barW);
      const color = it.color ?? (c.highlight === it.label ? HIGHLIGHT : CHART_COLORS[0]);
      return `<text x="${labelW - 6}" y="${y + 11}" text-anchor="end">${esc(trunc(it.label, 24))}</text>` +
        `<rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${rowH - 6}" rx="2" fill="${color}"/>` +
        `<text x="${labelW + w + 5}" y="${y + 11}" opacity=".85">${esc(it.display ?? fmt(it.value))}</text>`;
    })
    .join('');
  return frame(c.title, items.length * rowH + 8, body, items.map((i) => `${i.label}: ${i.display ?? fmt(i.value)}`).join('; '));
}

function legend(labels: string[], y: number, colors: string[] = CHART_COLORS): { svg: string; height: number } {
  let x = 0;
  let row = 0;
  let out = '';
  labels.forEach((l, i) => {
    const w = 22 + Math.min(l.length, 30) * 6;
    if (x + w > W) {
      x = 0;
      row += 1;
    }
    out += `<rect x="${x}" y="${y + row * 16}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/>` +
      `<text x="${x + 14}" y="${y + row * 16 + 9}">${esc(trunc(l, 30))}</text>`;
    x += w;
  });
  return { svg: out, height: (row + 1) * 16 };
}

function stackChart(c: Extract<ReportChart, { kind: 'stack' }>): string {
  const rows = c.rows.slice(0, 25).filter((r) => r.values.some((v) => v > 0));
  if (!rows.length) return '';
  const rowH = 24;
  const labelW = 150;
  const barW = W - labelW - (c.normalize ? 8 : 60);
  const totals = rows.map((r) => r.values.reduce((s, v) => s + Math.max(0, v), 0));
  const maxTotal = Math.max(...totals, 1e-9);
  const parts = rows.map((r, i) => {
    const y = i * rowH + 4;
    const scale = c.normalize ? totals[i] || 1 : maxTotal;
    let x = labelW;
    let s = `<text x="${labelW - 6}" y="${y + 12}" text-anchor="end">${esc(trunc(r.label, 24))}</text>`;
    r.values.forEach((v, k) => {
      const w = (Math.max(0, v) / scale) * barW;
      if (w <= 0) return;
      s += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rowH - 8}" fill="${CHART_COLORS[k % CHART_COLORS.length]}"/>`;
      if (w > 34) {
        s += `<text x="${(x + w / 2).toFixed(1)}" y="${y + 12}" text-anchor="middle" fill="#fff" font-size="10">${c.normalize ? `${Math.round((v / scale) * 100)}%` : fmt(v)}</text>`;
      }
      x += w;
    });
    if (!c.normalize) s += `<text x="${(x + 5).toFixed(1)}" y="${y + 12}" opacity=".85">${esc(fmt(totals[i]))}</text>`;
    return s;
  });
  const lg = legend(c.series, rows.length * rowH + 14);
  const desc = rows.map((r) => `${r.label}: ${r.values.map((v, k) => `${c.series[k]} ${fmt(v)}`).join(', ')}`).join('; ');
  return frame(c.title, rows.length * rowH + 14 + lg.height + 4, parts.join('') + lg.svg, desc);
}

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

function donutChart(c: Extract<ReportChart, { kind: 'donut' }>): string {
  const items = c.items.filter((i) => i.value > 0);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!items.length || total <= 0) return '';
  const cx = 90;
  const cy = 90;
  const sliceCount = items.length;
  let a = -Math.PI / 2;
  const arcs = items
    .map((it, i) => {
      const sweep = (it.value / total) * Math.PI * 2;
      const end = a + (sliceCount === 1 ? Math.PI * 2 - 0.0001 : sweep);
      const d = arcPath(cx, cy, 52, 84, a, end);
      a += sweep;
      return `<path d="${d}" fill="${CHART_COLORS[i % CHART_COLORS.length]}"><title>${esc(it.label)}: ${fmt(it.value)} (${((it.value / total) * 100).toFixed(1)}%)</title></path>`;
    })
    .join('');
  const center = `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="16" font-weight="600">${esc(fmt(total))}</text>` +
    `<text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="10" opacity=".7">${esc(c.centerLabel ?? 'total')}</text>`;
  const lg = items
    .slice(0, 10)
    .map((it, i) => {
      const y = 14 + i * 17;
      return `<rect x="200" y="${y - 9}" width="10" height="10" rx="2" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/>` +
        `<text x="216" y="${y}">${esc(trunc(it.label, 30))}</text>` +
        `<text x="${W - 4}" y="${y}" text-anchor="end" opacity=".85">${((it.value / total) * 100).toFixed(1)}%</text>`;
    })
    .join('');
  const h = Math.max(184, 14 + Math.min(items.length, 10) * 17 + 8);
  return frame(c.title, h, arcs + center + lg, items.map((i) => `${i.label}: ${fmt(i.value)}`).join('; '));
}

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function scatterChart(c: Extract<ReportChart, { kind: 'scatter' }>): string {
  const pts = c.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return '';
  const H = 250;
  const l = 52;
  const r = 12;
  const t = 8;
  const b = 38;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const px = (v: number) => l + ((v - x0) / (x1 - x0 || 1)) * (W - l - r);
  const py = (v: number) => H - b - ((v - y0) / (y1 - y0 || 1)) * (H - t - b);
  const xt = niceTicks(x0, x1);
  const yt = niceTicks(y0, y1);
  const grid =
    yt.map((v) => `<line x1="${l}" x2="${W - r}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" stroke="currentColor" opacity=".13"/><text x="${l - 6}" y="${(py(v) + 3).toFixed(1)}" text-anchor="end" opacity=".75">${esc(fmt(v))}</text>`).join('') +
    xt.map((v) => `<text x="${px(v).toFixed(1)}" y="${H - b + 14}" text-anchor="middle" opacity=".75">${esc(fmt(v))}</text>`).join('');
  const dots = pts
    .map((p) => {
      const hi = c.highlight === p.label;
      return `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${hi ? 6 : 3.6}" fill="${hi ? HIGHLIGHT : CHART_COLORS[0]}" fill-opacity="${hi ? 1 : 0.7}"><title>${esc(p.label)}: ${esc(fmt(p.x))}, ${esc(fmt(p.y))}</title></circle>`;
    })
    .join('');
  const axes = `<text x="${(l + W - r) / 2}" y="${H - 6}" text-anchor="middle" opacity=".85">${esc(c.xLabel)}</text>` +
    `<text transform="translate(12 ${(t + H - b) / 2}) rotate(-90)" text-anchor="middle" opacity=".85">${esc(c.yLabel)}</text>`;
  return frame(c.title, H, grid + dots + axes, `${c.yLabel} against ${c.xLabel} for ${pts.length} barangays`);
}

/** Markup for one chart (empty string when there is nothing to draw). */
export function chartToSvg(chart: ReportChart): string {
  switch (chart.kind) {
    case 'bar': return barChart(chart);
    case 'donut': return donutChart(chart);
    case 'stack': return stackChart(chart);
    case 'scatter': return scatterChart(chart);
  }
}
