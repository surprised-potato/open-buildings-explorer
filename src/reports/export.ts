import type { ReportOutput, ReportTable } from './types';

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tableToCsv(t: ReportTable): string {
  return [t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/** All tables of a report as one CSV, each preceded by its heading. */
export function reportToCsv(r: ReportOutput): string {
  const parts: string[] = [csvCell(r.title), csvCell(r.subtitle), ''];
  for (const s of r.sections) {
    parts.push(csvCell(s.heading));
    if (s.facts) for (const [k, v] of s.facts) parts.push(`${csvCell(k)},${csvCell(v)}`);
    if (s.table) parts.push(tableToCsv(s.table));
    parts.push('');
  }
  parts.push('Caveats', ...r.caveats.map(csvCell));
  return parts.join('\r\n');
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Standalone printable HTML (use the browser's print dialog to save as PDF). */
export function reportToHtml(r: ReportOutput): string {
  const body = r.sections
    .map((s) => {
      const facts = s.facts
        ? `<dl>${s.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
        : '';
      const table = s.table
        ? `<table><thead><tr>${s.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${s.table.rows
            .map((row) => `<tr>${row.map((c) => `<td>${esc(c === null ? '' : String(c))}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
        : '';
      const note = s.note ? `<p class="note">${esc(s.note)}</p>` : '';
      return `<section><h2>${esc(s.heading)}</h2>${facts}${table}${note}</section>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
body{font:13px/1.45 system-ui,sans-serif;color:#0f172a;max-width:860px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0}p.sub{color:#475569;margin:4px 0 18px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #cbd5e1;padding-bottom:3px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 16px;margin:0}dt{color:#475569}dd{margin:0;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #e2e8f0;padding:3px 6px;text-align:left}th{background:#f1f5f9}
.note,.cav{color:#475569;font-size:12px}tr{break-inside:avoid}</style></head><body>
<h1>${esc(r.title)}</h1><p class="sub">${esc(r.subtitle)}</p>${body}
<h2>Caveats</h2><ul class="cav">${r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></body></html>`;
}

export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openPrintable(html: string): void {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
}
