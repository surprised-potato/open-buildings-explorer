import {
  ArrowLeftRight,
  Building2,
  Download,
  FileText,
  Landmark,
  MapPin,
  Printer,
  Route,
  ShieldCheck,
  Store,
  Table2,
  Activity,
  Users,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTwinStore } from '../layers/registry';
import { REPORTS } from '../reports/catalog';
import { downloadText, openPrintable, reportToCsv, reportToHtml } from '../reports/export';
import type { PropertyData, PurposeMixData, ReportContext, ReportOutput } from '../reports/types';
import { chartToSvg } from '../reports/charts';
import { loadBuildingZonal } from '../utils/buildingZonal';
import {
  BACKGROUND_LABEL,
  getBackgroundStats,
  getReportSimulation,
  isBackgroundRunning,
  runBackgroundSimulation,
} from '../reports/headlessSim';
import { aggregateTripGeneration, type TripGenSnapshot } from '../reports/tripGeneration';
import {
  aggregateCorridors,
  findStreet,
  loadEdgeStreets,
  type CorridorSnapshot,
  type EdgeStreets,
} from '../reports/corridors';

const REPORT_ICONS: Record<string, LucideIcon> = {
  'city-snapshot': Building2,
  'barangay-profile': MapPin,
  'barangay-ranking': Table2,
  'business-poi': Store,
  'data-quality': ShieldCheck,
  'mobility-snapshot': Activity,
  'corridor-comparison': Route,
  'trip-generation': ArrowLeftRight,
  'trip-purpose': Users,
  'property-value': Landmark,
  'terrain-exposure': Waves,
};

export function ReportsPanel({ onClose }: { onClose: () => void }) {
  const { barangayAnalytics, buildingPois, mobilityStats, selectedBarangayName, setSelectedBarangayName } =
    useTwinStore();
  const [reportId, setReportId] = useState(REPORTS[0].id);
  const [edgeStreets, setEdgeStreets] = useState<EdgeStreets | null>(null);
  const [corridors, setCorridors] = useState<CorridorSnapshot | null>(null);
  const [tripGen, setTripGen] = useState<TripGenSnapshot | null>(null);
  const [corridorA, setCorridorA] = useState<string | null>(null);
  const [corridorB, setCorridorB] = useState<string | null>(null);
  const [bg, setBg] = useState<{ running: boolean; progress: number; error: string | null }>({
    running: false,
    progress: 0,
    error: null,
  });
  const [simVersion, setSimVersion] = useState(0);
  const [purposeMix, setPurposeMix] = useState<PurposeMixData | null>(null);
  const [property, setProperty] = useState<PropertyData | null>(null);
  const [zonal, setZonal] = useState<{ counts: number[]; labels: string[] } | null>(null);

  useEffect(() => {
    let live = true;
    void loadBuildingZonal(import.meta.env.BASE_URL).then((t) => {
      if (live && t?.meta.tierCounts) setZonal({ counts: t.meta.tierCounts, labels: t.meta.tierLabels });
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`${import.meta.env.BASE_URL}data/bacolod/barangay_property.json`)
      .then((r) => (r.ok ? (r.json() as Promise<PropertyData>) : null))
      .then((d) => {
        if (live && d) setProperty(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const base = `${import.meta.env.BASE_URL}data/bacolod/`;
    const get = (f: string) => fetch(`${base}${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void Promise.all([get('barangay_demand.json'), get('barangay_demographics.json'), get('barangay_typology.json')]).then(
      ([demand, demographics, typology]) => {
        if (live && demand && demographics) setPurposeMix({ demand, demographics, typology });
      }
    );
    return () => {
      live = false;
    };
  }, []);

  const def = REPORTS.find((r) => r.id === reportId) ?? REPORTS[0];
  const wantsCorridors = Boolean(def.needsCorridors);
  const wantsTally = Boolean(def.needsTripTally);
  const wantsSim = Boolean(def.needsSim);
  const simSource = getReportSimulation()?.source ?? null;

  // No live simulation open: prefill by running the morning-peak scenario in the background.
  const startBackground = (force = false) => {
    if (isBackgroundRunning()) return;
    if (!force && (getReportSimulation() || getBackgroundStats())) return;
    setBg({ running: true, progress: 0, error: null });
    runBackgroundSimulation(import.meta.env.BASE_URL, (f) => setBg((s) => ({ ...s, progress: f })))
      .then(() => {
        setBg({ running: false, progress: 1, error: null });
        setSimVersion((v) => v + 1);
      })
      .catch((e: unknown) => setBg({ running: false, progress: 0, error: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(() => {
    if (wantsSim) startBackground();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsSim]);

  // Street names load once; the live snapshot refreshes every 2 s while the report is open.
  useEffect(() => {
    if (!wantsCorridors) return;
    let live = true;
    void loadEdgeStreets(import.meta.env.BASE_URL).then((s) => {
      if (live) setEdgeStreets(s);
    });
    return () => {
      live = false;
    };
  }, [wantsCorridors]);

  useEffect(() => {
    if (!wantsCorridors || !edgeStreets) return;
    const take = () => {
      const sim = getReportSimulation()?.sim;
      if (!sim) {
        setCorridors(null);
        return;
      }
      const rows = aggregateCorridors(edgeStreets, sim.getEdgeLengthsKm(), sim.getEdgeLoad());
      setCorridors({ rows, takenAt: Date.now() });
    };
    take();
    const id = window.setInterval(take, 2000);
    return () => window.clearInterval(id);
  }, [wantsCorridors, edgeStreets, simVersion]);

  // Per-building trip tally, refreshed every 2 s while that report is open.
  useEffect(() => {
    if (!wantsTally) return;
    const take = () => {
      const sim = getReportSimulation()?.sim;
      const bt = sim?.dataset.buildings;
      if (!sim || !bt) {
        setTripGen(null);
        return;
      }
      const zones = sim.dataset.meta.zones.map((z) => z.name);
      setTripGen(aggregateTripGeneration(bt, zones, sim.getTripTally()));
    };
    take();
    const id = window.setInterval(take, 2000);
    return () => window.clearInterval(id);
  }, [wantsTally, simVersion]);

  // Default comparison: the Burgos vs C.L. Montelibano question that started this.
  useEffect(() => {
    if (!corridors) return;
    setCorridorA((cur) => cur ?? findStreet(corridors.rows, 'Burgos Street')?.key ?? findStreet(corridors.rows, 'Burgos')?.key ?? null);
    setCorridorB((cur) => cur ?? findStreet(corridors.rows, 'Montelibano Avenue')?.key ?? findStreet(corridors.rows, 'Montelibano')?.key ?? null);
  }, [corridors]);

  const streetOptions = useMemo(
    () =>
      (corridors?.rows ?? [])
        .filter((r) => r.lengthKm >= 0.3)
        .sort((x, y) => x.name.localeCompare(y.name)),
    [corridors]
  );
  const categories = useMemo(() => [...new Set(REPORTS.map((r) => r.category))], []);
  const names = useMemo(
    () => (barangayAnalytics?.barangays ?? []).map((b) => b.name).sort((a, b) => a.localeCompare(b)),
    [barangayAnalytics]
  );

  const report = useMemo<ReportOutput | null>(() => {
    if (!barangayAnalytics) return null;
    const ctx: ReportContext = {
      property,
      purposeMix,
      tripGen,
      corridors,
      corridorA,
      corridorB,
      analytics: barangayAnalytics,
      pois: buildingPois,
      barangay: selectedBarangayName,
      mobilityStats: mobilityStats.loaded ? mobilityStats : getBackgroundStats(),
      zonalTierCounts: zonal?.counts ?? null,
      zonalTierLabels: zonal?.labels ?? null,
    };
    return def.build(ctx);
  }, [def, barangayAnalytics, buildingPois, selectedBarangayName, mobilityStats, simVersion, zonal, property, purposeMix, tripGen, corridors, corridorA, corridorB]);

  const slug = `${def.id}${def.needsBarangay && selectedBarangayName ? `-${selectedBarangayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}`;
  const blocked = Boolean(def.needsBarangay && !selectedBarangayName);
  const csvSlug = def.needsCorridors ? `${slug}-${new Date().toISOString().slice(11, 16).replace(':', '')}` : slug;

  return (
    <aside className="hud-reports glass-panel" aria-label="Reports">
      <header className="hud-inspector-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <FileText size={15} style={{ color: 'var(--accent)' }} />
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Reports</h2>
        </div>
        <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close reports" title="Close">
          <X size={15} />
        </button>
      </header>

      <div className="reports-layout">
        <div className="reports-side scrollable-panel">
        <section aria-label="Choose a report">
          {categories.map((cat) => (
            <div key={cat} className="report-group">
              <h3 className="section-label">{cat}</h3>
              <div className="report-list" role="listbox" aria-label={`${cat} reports`}>
                {REPORTS.filter((r) => r.category === cat).map((r) => {
                  const Icon = REPORT_ICONS[r.id] ?? FileText;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="option"
                      aria-selected={r.id === reportId}
                      className={`report-item ${r.id === reportId ? 'active' : ''}`}
                      onClick={() => setReportId(r.id)}
                      title={r.description}
                    >
                      <span className="report-item-icon" aria-hidden="true"><Icon size={16} /></span>
                      <span className="report-item-text">
                        <span className="report-item-title">{r.title}</span>
                        <span className="report-item-desc">{r.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        </div>

        <div className="reports-main scrollable-panel">
          <div className="report-toolbar">
        {def.needsBarangay && (
          <section>
            <label className="section-label" htmlFor="report-barangay">Barangay</label>
            <select
              id="report-barangay"
              className="text-input"
              value={selectedBarangayName ?? ''}
              onChange={(e) => setSelectedBarangayName(e.target.value || null)}
            >
              <option value="">Select a barangay…</option>
              {names.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </section>
        )}

        {def.needsCorridors && (
          <section className="report-streets">
            {([['Street A', corridorA, setCorridorA], ['Street B', corridorB, setCorridorB]] as const).map(
              ([label, value, set]) => (
                <label key={label} className="report-street">
                  <span className="section-label">{label}</span>
                  <select
                    className="text-input"
                    value={value ?? ''}
                    onChange={(e) => set(e.target.value || null)}
                    disabled={streetOptions.length === 0}
                  >
                    <option value="">Select a street…</option>
                    {streetOptions.map((r) => (
                      <option key={r.key} value={r.key}>{r.name}</option>
                    ))}
                  </select>
                </label>
              )
            )}
          </section>
        )}

        {wantsSim && (
          <section className="report-source" aria-live="polite">
            {bg.running ? (
              <>
                <span>Running a background simulation (06:30 to 08:30)… {Math.round(bg.progress * 100)}%</span>
                <progress value={bg.progress} max={1} aria-label="Background simulation progress" />
              </>
            ) : bg.error ? (
              <>
                <span>Could not run the simulation: {bg.error}</span>
                <button type="button" className="btn" onClick={() => startBackground(true)}>Retry</button>
              </>
            ) : simSource === 'live' ? (
              <span>Source: live simulation (Simulate view)</span>
            ) : simSource === 'background' ? (
              <>
                <span>Source: {BACKGROUND_LABEL}</span>
                <button type="button" className="btn" onClick={() => startBackground(true)} title="Run the scenario again">
                  Re-run
                </button>
              </>
            ) : null}
          </section>
        )}

        {def.needsTripTally && simSource === 'live' && (
          <section>
            <button
              type="button"
              className="btn"
              onClick={() => getReportSimulation()?.sim.resetTripTally()}
              title="Start counting trips from zero"
            >
              Reset counts
            </button>
          </section>
        )}

        <section className="report-actions">
          <button type="button" className="btn" disabled={!report || blocked}
            onClick={() => report && downloadText(`${csvSlug}.csv`, 'text/csv', reportToCsv(report))}>
            <Download size={13} /> CSV
          </button>
          <button type="button" className="btn" disabled={!report || blocked}
            onClick={() => report && openPrintable(reportToHtml(report))}
            title="Opens a printable page; use Print > Save as PDF">
            <Printer size={13} /> Print / PDF
          </button>
        </section>
          </div>
        <section className="report-preview" aria-live="polite">
          {!report && <p className="report-note">Loading analytics…</p>}
          {report && blocked && <p className="report-note">Pick a barangay above, or click one on the map.</p>}
          {wantsSim && bg.running && (
            <p className="report-note">Preparing this report: simulating the morning peak in the background. The map and other reports stay usable.</p>
          )}
          {report && !blocked && !(wantsSim && bg.running) && (
            <>
              <h3 className="report-title">{report.title}</h3>
              <p className="report-note">{report.subtitle}</p>
              {report.sections.map((s) => (
                <div key={s.heading} className="report-section">
                  <h4>{s.heading}</h4>
                  {s.facts && (
                    <dl className="report-facts">
                      {s.facts.map(([k, v]) => (
                        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                      ))}
                    </dl>
                  )}
                  {s.charts?.length ? (
                    <div className="report-charts">
                      {s.charts.map((c) => {
                        const svg = chartToSvg(c);
                        return svg ? (
                          <figure key={c.title} className="report-chart">
                            <figcaption>{c.title}</figcaption>
                            <div dangerouslySetInnerHTML={{ __html: svg }} />
                            {c.note && <p className="report-note">{c.note}</p>}
                          </figure>
                        ) : null;
                      })}
                    </div>
                  ) : null}
                  {s.table && (
                    <div className="report-table-wrap">
                      <table className="report-table">
                        <thead><tr>{s.table.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                        <tbody>
                          {s.table.rows.slice(0, 300).map((row, i) => (
                            <tr key={i}>{row.map((c, j) => <td key={j}>{c === null ? '' : String(c)}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                      {s.table.rows.length > 300 && (
                        <p className="report-note">Showing 300 of {s.table.rows.length} rows. Export for the full table.</p>
                      )}
                    </div>
                  )}
                  {s.note && <p className="report-note">{s.note}</p>}
                </div>
              ))}
              {report.caveats.length > 0 && (
                <div className="report-section">
                  <h4>Caveats</h4>
                  <ul className="report-caveats">{report.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
                </div>
              )}
            </>
          )}
        </section>
              </div>
      </div>
    </aside>
  );
}
