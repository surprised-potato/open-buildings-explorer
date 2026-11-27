import {
  ArrowLeftRight,
  BarChart3,
  Building2,
  Crosshair,
  Flame,
  MapPin,
  Search,
  Sparkles,
  Trees,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { CHOROPLETH_CONFIG } from '../layers/builtins/boundariesLayer';
import { POI_CATEGORY_COLORS } from '../layers/builtins/buildingsLayer';
import { useTwinStore } from '../layers/registry';
import type {
  BarangayAnalyticsItem,
  BarangayChoroplethMetric,
} from '../layers/types';
import { formatArea } from '../utils/geometry';
import {
  analyzeSiteCatchment,
  SITE_CATEGORIES,
} from '../utils/siteSelection';
import { MobilityTabPanel } from './MobilityTabPanel';
import { getPlaceMeta } from '../utils/place';

interface AnalyticsPanelProps {
  open: boolean;
  /** Which task view hosts this panel: analyze shows barangays/site, simulate shows mobility. */
  view: 'analyze' | 'simulate';
  onClose: () => void;
  sitePickMode: boolean;
  onToggleSitePickMode: (next: boolean) => void;
  siteCenter: [number, number] | null;
  siteRadiusM: 300 | 500 | 1000;
  onChangeSiteRadius: (r: 300 | 500 | 1000) => void;
  onClearSite: () => void;
  onFlyTo: (camera: {
    center: [number, number];
    zoom?: number;
    pitch?: number;
    bearing?: number;
  }) => void;
  onFitBounds: (bbox: [number, number, number, number]) => void;
}

type AnalyticsTab = 'barangays' | 'site' | 'mobility';

const CHOROPLETH_OPTIONS: Array<{
  value: BarangayChoroplethMetric;
  label: string;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'building_density_per_km2', label: 'Density' },
  { value: 'commercial_share_pct', label: 'Commercial %' },
  { value: 'poi_count', label: 'POIs' },
  { value: 'built_coverage_pct', label: 'Built %' },
  { value: 'mean_elev_m', label: 'Elevation' },
  { value: 'green_space_pct', label: 'Green %' },
  { value: 'tree_cover_pct', label: 'Tree cover' },
  { value: 'pop_density_per_km2', label: 'Population density' },
  { value: 'children_pct', label: 'Children (0–14)' },
  { value: 'seniors_pct', label: 'Seniors (60+)' },
  { value: 'zonal_res_median', label: 'Land ₱ (res)' },
  { value: 'zonal_com_median', label: 'Land ₱ (com)' },
];

function getMetricValue(
  row: BarangayAnalyticsItem,
  metric: BarangayChoroplethMetric
): number {
  if (metric === 'off') return row.building_count;
  const val = row[metric];
  return typeof val === 'number' && Number.isFinite(val) ? val : 0;
}

function formatMetricValue(
  row: BarangayAnalyticsItem,
  metric: BarangayChoroplethMetric
): string {
  if (metric === 'off') return `${row.building_count.toLocaleString()}`;
  const val = getMetricValue(row, metric);
  if (metric === 'building_density_per_km2') return `${Math.round(val).toLocaleString()}/km²`;
  if (metric === 'poi_count') return `${Math.round(val).toLocaleString()}`;
  if (metric === 'zonal_res_median' || metric === 'zonal_com_median') {
    return val > 0 ? `₱${Math.round(val).toLocaleString()}` : '—';
  }
  if (metric === 'mean_elev_m') {
    return row.mean_elev_m !== null ? `${row.mean_elev_m.toFixed(1)} m` : '—';
  }
  return `${val.toFixed(1)}%`;
}

export function AnalyticsPanel({
  open,
  view,
  onClose,
  sitePickMode,
  onToggleSitePickMode,
  siteCenter,
  siteRadiusM,
  onChangeSiteRadius,
  onClearSite,
  onFlyTo,
  onFitBounds,
}: AnalyticsPanelProps) {
  const {
    barangayAnalytics,
    barangayChoropleth,
    setBarangayChoropleth,
    selectedBarangayName,
    setSelectedBarangayName,
    poiCategoryFilter,
    setPoiCategoryFilter,
    buildingPois,
    catchmentGrid,
    layerState,
    toggleLayer,
    selectedFeature,
    setSelectedFeature,
    sampleElevation,
  } = useTwinStore();

  const [rawTab, setTab] = useState<AnalyticsTab>('barangays');
  const tab: AnalyticsTab =
    view === 'simulate' ? 'mobility' : rawTab === 'mobility' ? 'barangays' : rawTab;
  const [brgyQuery, setBrgyQuery] = useState('');
  const [compareBrgyName, setCompareBrgyName] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [targetCategory, setTargetCategory] = useState<string>('food');

  const sortedBarangays = useMemo(() => {
    const rows = barangayAnalytics?.barangays ?? [];
    const q = brgyQuery.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.name.toLowerCase().includes(q))
      : rows;
    return [...filtered].sort(
      (a, b) =>
        getMetricValue(b, barangayChoropleth) -
        getMetricValue(a, barangayChoropleth)
    );
  }, [barangayAnalytics, brgyQuery, barangayChoropleth]);

  const maxMetricValue = useMemo(() => {
    let maxVal = 1;
    for (const row of sortedBarangays) {
      const v = getMetricValue(row, barangayChoropleth);
      if (v > maxVal) maxVal = v;
    }
    return maxVal;
  }, [sortedBarangays, barangayChoropleth]);

  const selectedBrgy = useMemo(() => {
    if (!selectedBarangayName || !barangayAnalytics) return null;
    return (
      barangayAnalytics.barangays.find((b) => b.name === selectedBarangayName) ??
      null
    );
  }, [barangayAnalytics, selectedBarangayName]);

  const compareBrgy = useMemo(() => {
    if (!compareBrgyName || !barangayAnalytics) return null;
    return (
      barangayAnalytics.barangays.find((b) => b.name === compareBrgyName) ??
      null
    );
  }, [barangayAnalytics, compareBrgyName]);

  const topCommercialHubs = useMemo(() => {
    return Object.values(buildingPois)
      .filter((r) => r.poi_count >= 2 && Array.isArray(r.center))
      .sort((a, b) => b.poi_count - a.poi_count)
      .slice(0, 10);
  }, [buildingPois]);

  const siteAnalysis = useMemo(() => {
    if (!siteCenter) return null;
    const elev = sampleElevation(siteCenter[0], siteCenter[1]);
    return analyzeSiteCatchment({
      center: siteCenter,
      radiusM: siteRadiusM,
      targetCategory,
      buildingPois,
      catchmentGrid,
      groundElevationM: elev,
    });
  }, [
    siteCenter,
    siteRadiusM,
    targetCategory,
    buildingPois,
    catchmentGrid,
    sampleElevation,
  ]);

  if (!open) return null;

  const heatmapVisible = Boolean(layerState['poi-heatmap']?.visible);
  const citywide = barangayAnalytics?.citywide;

  const selectBuildingHub = (buildingId: string) => {
    const rec = buildingPois[buildingId];
    if (!rec) return;
    if (Array.isArray(rec.center)) {
      onFlyTo({
        center: rec.center,
        zoom: 17.2,
        pitch: 58,
        bearing: -18,
      });
    }
    setSelectedFeature({
      layerId: 'buildings',
      layerName: '3D Buildings',
      id: rec.id,
      coordinates: rec.center,
      properties: {
        id: rec.id,
        name: rec.name,
        bclass: rec.bclass,
        class_source: rec.class_source,
        effective_height: rec.effective_height,
        height_source: rec.height_source,
        num_floors: rec.num_floors,
        area_m2: rec.area_m2,
        primary_source: rec.primary_source,
        poi_count: rec.poi_count,
      },
    });
  };

  return (
    <aside
      className="hud-analytics glass-panel"
      aria-label="Urban analytics and site selection"
    >
      <header className="hud-inspector-header">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <BarChart3 size={15} style={{ color: 'var(--accent)' }} />
            <h2
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--text-primary)',
              }}
            >
              {view === 'simulate' ? 'Mobility Simulation' : 'Urban Analytics'}
            </h2>
          </div>
          {view === 'analyze' && (
          <div className="segmented-control" role="tablist" aria-label="Analytics mode">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'barangays'}
              className={`segmented-btn ${tab === 'barangays' ? 'active' : ''}`}
              onClick={() => setTab('barangays')}
            >
              Barangays ({barangayAnalytics?.barangays.length ?? 61})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'site'}
              className={`segmented-btn ${tab === 'site' ? 'active' : ''}`}
              onClick={() => setTab('site')}
            >
              Site Selection
            </button>
          </div>
          )}
        </div>

        <button
          type="button"
          className="btn btn-icon btn-ghost"
          onClick={onClose}
          aria-label="Close panel"
          title="Close"
        >
          <X size={15} />
        </button>
      </header>

      <div className="hud-inspector-body scrollable-panel">
        {tab === 'barangays' && (
          <>
            <section>
              <div className="control-row" style={{ marginBottom: 6 }}>
                <h3 className="section-label" style={{ margin: 0 }}>
                  Choropleth Map Shading
                </h3>
                {barangayChoropleth !== 'off' && (
                  <span style={{ fontSize: 10.5, color: 'var(--accent)' }}>
                    {CHOROPLETH_CONFIG[barangayChoropleth].shortLabel}
                  </span>
                )}
              </div>
              <div className="choropleth-pills" role="group" aria-label="Barangay choropleth metric">
                {CHOROPLETH_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`pill pill-btn ${
                      barangayChoropleth === opt.value ? 'active-pill' : ''
                    }`}
                    onClick={() => setBarangayChoropleth(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </section>

            {citywide && (
              <section className="metrics-grid">
                <div className="metric-box">
                  <div className="metric-label">City Buildings</div>
                  <div className="metric-value">
                    {citywide.building_count.toLocaleString()}
                  </div>
                </div>
                <div className="metric-box">
                  <div className="metric-label">Commercial / Mix</div>
                  <div className="metric-value">
                    {citywide.commercial_count.toLocaleString()}
                  </div>
                </div>
                <div className="metric-box">
                  <div className="metric-label">Linked POIs</div>
                  <div className="metric-value">
                    {citywide.poi_count.toLocaleString()}
                  </div>
                </div>
                <div className="metric-box">
                  <div className="metric-label">Built / Green</div>
                  <div className="metric-value" style={{ fontSize: 12.5 }}>
                    {citywide.built_coverage_pct}% / {citywide.green_space_pct}%
                  </div>
                </div>
              </section>
            )}

            {selectedBrgy && (
              <section className="analytics-detail-card">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{selectedBrgy.name}</strong>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className={`btn ${compareMode ? 'active' : ''}`}
                      style={{ height: 24, fontSize: 11, paddingInline: 8 }}
                      onClick={() => {
                        setCompareMode((prev) => !prev);
                        if (!compareMode && !compareBrgyName) {
                          const alt = sortedBarangays.find(
                            (b) => b.name !== selectedBrgy.name
                          );
                          setCompareBrgyName(alt?.name ?? null);
                        }
                      }}
                    >
                      <ArrowLeftRight size={11} />
                      Compare
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-ghost"
                      style={{ width: 24, height: 24 }}
                      onClick={() => {
                        setSelectedBarangayName(null);
                        setCompareMode(false);
                        if (selectedFeature?.layerId === 'boundaries') {
                          setSelectedFeature(null);
                        }
                      }}
                      aria-label="Clear selected barangay"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>

                <div className="metrics-grid" style={{ marginTop: 8 }}>
                  <div className="metric-box">
                    <div className="metric-label">Density</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {Math.round(selectedBrgy.building_density_per_km2).toLocaleString()}/km²
                    </div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Est. GFA</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {formatArea(selectedBrgy.est_gfa_m2)}
                    </div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Mean Elev.</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {selectedBrgy.mean_elev_m !== null
                        ? `${selectedBrgy.mean_elev_m.toFixed(1)} m`
                        : '—'}
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--text-muted)',
                          marginLeft: 4,
                        }}
                      >
                        ({selectedBrgy.low_lying_pct}% &lt;3m)
                      </span>
                    </div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Trees size={10} /> Green Space
                      </span>
                    </div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {selectedBrgy.green_space_pct}%
                    </div>
                  </div>
                </div>

                {/* Building class mix bar */}
                {selectedBrgy.building_count > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="control-row" style={{ marginBottom: 4 }}>
                      <span>Building Mix ({selectedBrgy.commercial_share_pct}% comm.)</span>
                      <span>{selectedBrgy.building_count.toLocaleString()}</span>
                    </div>
                    <div className="stacked-bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${(selectedBrgy.residential_count / selectedBrgy.building_count) * 100}%`,
                          background: '#60a5fa',
                        }}
                        title={`Residential: ${selectedBrgy.residential_count}`}
                      />
                      <span
                        style={{
                          width: `${(selectedBrgy.commercial_count / selectedBrgy.building_count) * 100}%`,
                          background: '#f59e0b',
                        }}
                        title={`Commercial/Mixed: ${selectedBrgy.commercial_count}`}
                      />
                      <span
                        style={{
                          width: `${(selectedBrgy.civic_edu_health_count / selectedBrgy.building_count) * 100}%`,
                          background: '#2dd4bf',
                        }}
                        title={`Civic/Edu/Health: ${selectedBrgy.civic_edu_health_count}`}
                      />
                      <span
                        style={{
                          width: `${(selectedBrgy.industrial_count / selectedBrgy.building_count) * 100}%`,
                          background: '#a78bfa',
                        }}
                        title={`Industrial: ${selectedBrgy.industrial_count}`}
                      />
                    </div>
                  </div>
                )}

                {Object.keys(selectedBrgy.poi_by_category).length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {Object.entries(selectedBrgy.poi_by_category)
                      .slice(0, 6)
                      .map(([cat, count]) => (
                        <span key={cat} className="pill" style={{ fontSize: 10 }}>
                          {cat}: {count}
                        </span>
                      ))}
                  </div>
                )}

                {selectedBrgy.zonal_res_median !== undefined && selectedBrgy.zonal_res_median !== null && (
                  <div style={{ marginTop: 8 }}>
                    <div className="metric-label" style={{ marginBottom: 4 }}>
                      Land Value · BIR Zonal (₱/m²)
                    </div>
                    <div className="metrics-grid">
                      <div className="metric-box">
                        <div className="metric-label">Residential</div>
                        <div className="metric-value" style={{ fontSize: 12.5 }}>
                          ₱{selectedBrgy.zonal_res_median.toLocaleString()}
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                            max ₱{(selectedBrgy.zonal_res_max ?? 0).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="metric-box">
                        <div className="metric-label">Commercial</div>
                        <div className="metric-value" style={{ fontSize: 12.5 }}>
                          {selectedBrgy.zonal_com_median != null
                            ? `₱${selectedBrgy.zonal_com_median.toLocaleString()}`
                            : '—'}
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                            max ₱{(selectedBrgy.zonal_com_max ?? 0).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    {(selectedBrgy.zonal_top_commercial ?? []).map((st) => (
                      <div
                        key={`${st.street}-${st.vicinity}`}
                        style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}
                      >
                        {st.street} · {st.vicinity.toLowerCase()} · ₱{st.value.toLocaleString()}
                      </div>
                    ))}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      {barangayAnalytics?.zonal
                        ? `BIR RDO 77, DO ${barangayAnalytics.zonal.department_order}, eff. ${barangayAnalytics.zonal.effectivity}. `
                        : ''}
                      Tax floor per street, not market price; median of street entries.
                    </div>
                  </div>
                )}

                {selectedBrgy.top_hubs.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div className="metric-label" style={{ marginBottom: 4 }}>
                      Top Commercial Hubs
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {selectedBrgy.top_hubs.map((hub) => (
                        <button
                          key={hub.id}
                          type="button"
                          className="hub-row-btn"
                          onClick={() => selectBuildingHub(hub.id)}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {hub.name}
                          </span>
                          <span className="pill" style={{ fontSize: 10 }}>
                            {hub.poi_count} POIs
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {compareMode && (
                  <div
                    style={{
                      marginTop: 10,
                      paddingTop: 8,
                      borderTop: '1px dashed var(--border-subtle)',
                    }}
                  >
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="metric-label">Compare With Barangay</span>
                      <select
                        className="select-input"
                        value={compareBrgyName ?? ''}
                        onChange={(e) => setCompareBrgyName(e.target.value || null)}
                      >
                        {(barangayAnalytics?.barangays ?? [])
                          .filter((b) => b.name !== selectedBrgy.name)
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((b) => (
                            <option key={b.name} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                      </select>
                    </label>

                    {compareBrgy && (
                      <table className="kv-table" style={{ marginTop: 6 }}>
                        <thead>
                          <tr>
                            <th>Metric</th>
                            <th>{selectedBrgy.name}</th>
                            <th>{compareBrgy.name}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <th scope="row">Buildings</th>
                            <td>{selectedBrgy.building_count.toLocaleString()}</td>
                            <td>{compareBrgy.building_count.toLocaleString()}</td>
                          </tr>
                          <tr>
                            <th scope="row">Density/km²</th>
                            <td>{Math.round(selectedBrgy.building_density_per_km2).toLocaleString()}</td>
                            <td>{Math.round(compareBrgy.building_density_per_km2).toLocaleString()}</td>
                          </tr>
                          <tr>
                            <th scope="row">Comm. Share</th>
                            <td>{selectedBrgy.commercial_share_pct}%</td>
                            <td>{compareBrgy.commercial_share_pct}%</td>
                          </tr>
                          <tr>
                            <th scope="row">POIs</th>
                            <td>{selectedBrgy.poi_count.toLocaleString()}</td>
                            <td>{compareBrgy.poi_count.toLocaleString()}</td>
                          </tr>
                          <tr>
                            <th scope="row">Mean Elev.</th>
                            <td>{selectedBrgy.mean_elev_m ?? '—'} m</td>
                            <td>{compareBrgy.mean_elev_m ?? '—'} m</td>
                          </tr>
                          <tr>
                            <th scope="row">Green %</th>
                            <td>{selectedBrgy.green_space_pct}%</td>
                            <td>{compareBrgy.green_space_pct}%</td>
                          </tr>
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </section>
            )}

            <section>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                <Search
                  size={13}
                  style={{ position: 'absolute', left: 9, color: 'var(--text-muted)', pointerEvents: 'none' }}
                />
                <input
                  type="text"
                  className="text-input"
                  style={{ paddingLeft: 28 }}
                  placeholder="Filter 61 barangays…"
                  value={brgyQuery}
                  onChange={(e) => setBrgyQuery(e.target.value)}
                  aria-label="Filter barangays"
                />
              </div>

              <div className="brgy-rank-list">
                {sortedBarangays.map((row) => {
                  const val = getMetricValue(row, barangayChoropleth);
                  const pct = Math.max(4, Math.min(100, (val / maxMetricValue) * 100));
                  const isActive = selectedBarangayName === row.name;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={`brgy-rank-row ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedBarangayName(row.name);
                        if (Array.isArray(row.bbox) && row.bbox.length === 4) {
                          onFitBounds(row.bbox);
                        }
                      }}
                    >
                      <div className="brgy-rank-top">
                        <span>{row.name}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                          {formatMetricValue(row, barangayChoropleth)}
                        </span>
                      </div>
                      <div className="brgy-bar-track">
                        <div className="brgy-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {tab === 'site' && (
          <>
            <section className="layer-card">
              <div className="layer-row">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12 }}>
                  <Flame size={14} style={{ color: '#f97316' }} />
                  POI Density Heatmap
                </span>
                <input
                  type="checkbox"
                  switch=""
                  checked={heatmapVisible}
                  aria-label="Toggle POI Density Heatmap"
                  onChange={(e) => toggleLayer('poi-heatmap', e.target.checked)}
                />
              </div>

              <h3 className="section-label" style={{ margin: '4px 0 2px' }}>
                Filter 3D Buildings by Business Type
              </h3>
              <div className="choropleth-pills">
                <button
                  type="button"
                  className={`pill pill-btn ${poiCategoryFilter === 'all' ? 'active-pill' : ''}`}
                  onClick={() => setPoiCategoryFilter('all')}
                >
                  All
                </button>
                {SITE_CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    type="button"
                    className={`pill pill-btn ${
                      poiCategoryFilter === cat.value ? 'active-pill' : ''
                    }`}
                    onClick={() => setPoiCategoryFilter(cat.value)}
                  >
                    <span
                      className="poi-cat-dot"
                      style={{ backgroundColor: POI_CATEGORY_COLORS[cat.value] ?? cat.color }}
                      aria-hidden="true"
                    />
                    {cat.value}
                  </button>
                ))}
              </div>
            </section>

            <section className="layer-card">
              <h3 className="section-label" style={{ margin: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Sparkles size={11} style={{ color: 'var(--accent)' }} />
                  Site Catchment Viability Scorer
                </span>
              </h3>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  Target Business Category
                </span>
                <select
                  className="select-input"
                  value={targetCategory}
                  onChange={(e) => setTargetCategory(e.target.value)}
                >
                  {SITE_CATEGORIES.map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="control-row">
                <span>Catchment Radius</span>
                <div className="segmented-control" role="group" aria-label="Catchment radius">
                  {([300, 500, 1000] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={`segmented-btn ${siteRadiusM === r ? 'active' : ''}`}
                      onClick={() => onChangeSiteRadius(r)}
                    >
                      {r === 1000 ? '1 km' : `${r} m`}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className={`btn ${sitePickMode ? 'btn-primary' : ''}`}
                  style={{ flex: 1, justifyContent: 'center' }}
                  onClick={() => onToggleSitePickMode(!sitePickMode)}
                  aria-pressed={sitePickMode}
                >
                  <Crosshair size={13} />
                  {sitePickMode ? 'Click Map to Score…' : 'Pick Site on Map'}
                </button>
                {siteCenter && (
                  <button
                    type="button"
                    className="btn"
                    onClick={onClearSite}
                  >
                    Clear
                  </button>
                )}
              </div>
            </section>

            {siteAnalysis && (
              <section className="analytics-detail-card">
                <div className="score-hero">
                  <div>
                    <div className="metric-label">Site Viability Score</div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                      {siteAnalysis.scores.overallScore}
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
                        /100
                      </span>
                    </div>
                  </div>
                  <div className="score-grade">{siteAnalysis.scores.grade}</div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  {[
                    { label: 'Residential Demand (30%)', val: siteAnalysis.scores.demandScore, color: '#60a5fa' },
                    { label: 'Foot Traffic / Anchors (25%)', val: siteAnalysis.scores.footTrafficScore, color: '#34d399' },
                    { label: 'Competition Gap (25%)', val: siteAnalysis.scores.competitionGapScore, color: '#f59e0b' },
                    { label: 'Arterial Road Access (10%)', val: siteAnalysis.scores.accessibilityScore, color: '#a78bfa' },
                    { label: 'Elevation Safety (10%)', val: siteAnalysis.scores.elevationSafetyScore, color: '#38bdf8' },
                  ].map((item) => (
                    <div key={item.label}>
                      <div className="control-row" style={{ fontSize: 11 }}>
                        <span>{item.label}</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{item.val}</span>
                      </div>
                      <div className="score-bar-track">
                        <div
                          className="score-bar-fill"
                          style={{ width: `${item.val}%`, backgroundColor: item.color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="metrics-grid" style={{ marginTop: 10 }}>
                  <div className="metric-box">
                    <div className="metric-label">Res. Catchment</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {siteAnalysis.residentialBuildings.toLocaleString()} bldgs
                    </div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Competitors</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {siteAnalysis.directCompetitorCount}
                    </div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Other Anchors</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {siteAnalysis.complementaryPoiCount} POIs
                    </div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Ground Elev.</div>
                    <div className="metric-value" style={{ fontSize: 12.5 }}>
                      {siteAnalysis.groundElevationM !== null
                        ? `${siteAnalysis.groundElevationM.toFixed(1)} m`
                        : '—'}
                    </div>
                  </div>
                </div>

                {siteAnalysis.competitors.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="metric-label" style={{ marginBottom: 4 }}>
                      Nearest Competitors ({siteAnalysis.directCompetitorCount})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {siteAnalysis.competitors.slice(0, 6).map((comp) => (
                        <button
                          key={`${comp.buildingId}-${comp.poiId}`}
                          type="button"
                          className="hub-row-btn"
                          onClick={() => selectBuildingHub(comp.buildingId)}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                            <MapPin size={11} style={{ color: '#f59e0b', flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {comp.name}
                            </span>
                          </span>
                          <span className="pill" style={{ fontSize: 10 }}>
                            {comp.distanceM} m
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {siteAnalysis.anchors.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="metric-label" style={{ marginBottom: 4 }}>
                      Nearby Anchor Hubs
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {siteAnalysis.anchors.map((anc) => (
                        <button
                          key={anc.buildingId}
                          type="button"
                          className="hub-row-btn"
                          onClick={() => selectBuildingHub(anc.buildingId)}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                            <Building2 size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {anc.name}
                            </span>
                          </span>
                          <span className="pill" style={{ fontSize: 10 }}>
                            {anc.poiCount} POIs · {anc.distanceM}m
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {!siteAnalysis && topCommercialHubs.length > 0 && (
              <section>
                <h3 className="section-label">Top Commercial Hubs in {getPlaceMeta().name}</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {topCommercialHubs.map((hub) => (
                    <button
                      key={hub.id}
                      type="button"
                      className="hub-row-btn"
                      onClick={() => selectBuildingHub(hub.id)}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {hub.name || hub.label || hub.id}
                      </span>
                      <span className="pill" style={{ fontSize: 10 }}>
                        {hub.poi_count} POIs
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {tab === 'mobility' && <MobilityTabPanel onFitBounds={onFitBounds} />}
      </div>
    </aside>
  );
}
