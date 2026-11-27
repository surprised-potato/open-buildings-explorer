import { describe, expect, it } from 'vitest';
import { chartToSvg, type ReportChart } from '../reports/charts';
import { reportToHtml } from '../reports/export';

describe('report charts', () => {
  it('draws a bar per item and escapes labels', () => {
    const svg = chartToSvg({ kind: 'bar', title: 'T <x>', items: [{ label: 'A&B', value: 5 }, { label: 'C', value: 10 }] });
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('A&amp;B');
    expect(svg).not.toContain('<x>');
  });

  it('donut slices follow the values and skip zeros', () => {
    const svg = chartToSvg({ kind: 'donut', title: 'D', items: [{ label: 'a', value: 3 }, { label: 'b', value: 1 }, { label: 'z', value: 0 }] });
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('75.0%');
  });

  it('normalised stacks fill the same width for every row', () => {
    const svg = chartToSvg({ kind: 'stack', title: 'S', series: ['x', 'y'], normalize: true, rows: [{ label: 'r1', values: [1, 1] }, { label: 'r2', values: [30, 10] }] });
    expect(svg).toContain('50%');
    expect(svg).toContain('75%');
  });

  it('returns nothing when there is nothing to draw', () => {
    const empty: ReportChart[] = [
      { kind: 'bar', title: 'e', items: [] },
      { kind: 'donut', title: 'e', items: [{ label: 'a', value: 0 }] },
      { kind: 'scatter', title: 'e', xLabel: 'x', yLabel: 'y', points: [{ label: 'a', x: 1, y: 1 }] },
    ];
    for (const c of empty) expect(chartToSvg(c)).toBe('');
  });

  it('scatter marks the highlighted point and the printable report embeds charts', () => {
    const chart: ReportChart = { kind: 'scatter', title: 'Sc', xLabel: 'x', yLabel: 'y', highlight: 'b', points: [{ label: 'a', x: 1, y: 2 }, { label: 'b', x: 3, y: 5 }] };
    expect(chartToSvg(chart)).toContain('r="6"');
    const html = reportToHtml({ title: 'R', subtitle: '', caveats: [], sections: [{ heading: 'H', charts: [chart] }] });
    expect(html).toContain('<svg');
    expect(html).toContain('<figcaption>Sc</figcaption>');
  });
});
