import { MapPin } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { getActiveSimulation } from '../utils/mobilitySim';
import { useTwinStore } from '../layers/registry';
import {
  MOBILITY_MODE_HEX,
  MOBILITY_PURPOSE_LABELS,
  type MobilityBarangayFilter,
  type MobilityColorMode,
  type MobilityModeId,
  type MobilityPurposeId,
} from '../utils/mobilityTypes';

const MODE_CHIP_ITEMS: Array<{
  id: MobilityModeId;
  label: string;
  color: string;
  title: string;
}> = [
  {
    id: 'puv',
    label: 'Jeepney/Bus',
    color: MOBILITY_MODE_HEX.puv,
    title: '15–20 passengers per vehicle · 2.0 PCU · Shared carriageway',
  },
  {
    id: 'motorcycle',
    label: 'Motorcycle',
    color: MOBILITY_MODE_HEX.motorcycle,
    title: '1–2 riders · 0.4 PCU · Lane-filtering (65% delay)',
  },
  {
    id: 'car',
    label: 'Car',
    color: MOBILITY_MODE_HEX.car,
    title: '1–3 passengers · 1.0 PCU · Shared carriageway',
  },
  {
    id: 'tricycle',
    label: 'Tricycle',
    color: MOBILITY_MODE_HEX.tricycle,
    title: '1–4 passengers · 0.6 PCU · Arterial ban >55 km/h',
  },
  {
    id: 'walk',
    label: 'Walk',
    color: MOBILITY_MODE_HEX.walk,
    title: 'Separate sidewalk · 0 PCU · Uncongested 4.5 km/h',
  },
];

const COLOR_MODE_OPTIONS: Array<{ value: MobilityColorMode; label: string }> = [
  { value: 'mode', label: 'Mode' },
  { value: 'speed', label: 'Traffic Speed' },
];

const BARANGAY_FLOW_OPTIONS: Array<{
  value: MobilityBarangayFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'both', label: 'Both' },
];

const PURPOSE_ITEMS: Array<{
  id: MobilityPurposeId;
  color: string;
}> = [
  { id: 'hbw', color: '#38bdf8' },
  { id: 'hbe', color: '#10b981' },
  { id: 'hbo', color: '#f59e0b' },
];

interface MobilityRangeSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}

function MobilityRangeSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  onChange,
}: MobilityRangeSliderProps) {
  const ref = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--control-value', String(value));
    el.style.setProperty('--attr-min', String(min));
    el.style.setProperty('--attr-max', String(max));
  }, [value, min, max]);

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = Number(e.target.value);
        e.currentTarget.style.setProperty('--control-value', String(next));
        e.currentTarget.style.setProperty('--attr-min', String(min));
        e.currentTarget.style.setProperty('--attr-max', String(max));
        onChange(next);
      }}
    />
  );
}

export function MobilityTabPanel({
  onFitBounds,
}: {
  onFitBounds?: (bbox: [number, number, number, number]) => void;
}) {
  const {
    selectedBarangayName,
    setSelectedBarangayName,
    barangayAnalytics,
    barangays,
    mobilityAgentCount,
    setMobilityAgentCount,
    mobilityBetaScale,
    mobilityGravityLambda,
    setMobilityGravityLambda,
    mobilityAttrBlend,
    setMobilityAttrBlend,
    setMobilityBetaScale,
    mobilityEnabledModes,
    toggleMobilityMode,
    mobilityBarangayFilter,
    setMobilityBarangayFilter,
    mobilityCongestionEnabled,
    setMobilityCongestionEnabled,
    mobilityCongestionLoad,
    setMobilityCongestionLoad,
    mobilityColorMode,
    setMobilityColorMode,
    mobilityShowCongestedRoads,
    setMobilityShowCongestedRoads,
    mobilityStats,
  } = useTwinStore();

  const totalTravellers = mobilityStats.totalTravellers || mobilityStats.activeAgents;
  const totalModeTravellers = MODE_CHIP_ITEMS.reduce(
    (sum, item) => sum + (mobilityStats.modeTravellers?.[item.id] ?? mobilityStats.modeCounts[item.id] ?? 0),
    0
  );
  const selectedZone = useMemo(
    () =>
      selectedBarangayName
        ? getActiveSimulation()?.dataset.meta.zones.find((z) => z.name === selectedBarangayName) ?? null
        : null,
    [selectedBarangayName, mobilityStats.loaded]
  );
  const totalSelectedPurposes = PURPOSE_ITEMS.reduce(
    (sum, item) => sum + (mobilityStats.selectedBarangayPurposes?.[item.id] ?? 0),
    0
  );
  const totalPurposeAgents = PURPOSE_ITEMS.reduce(
    (sum, item) => sum + (mobilityStats.purposeCounts[item.id] ?? 0),
    0
  );
  const tti = mobilityStats.travelTimeIndex ?? 1.0;
  const ttiColor =
    !mobilityCongestionEnabled || tti < 1.1
      ? 'var(--success)'
      : tti < 1.35
        ? 'var(--warning)'
        : 'var(--danger)';

  return (
    <>
      <section className="metrics-grid">
        <div className="metric-box">
          <div className="metric-label">Travellers Moved</div>
          <div className="metric-value" style={{ fontSize: 13 }}>
            {totalTravellers.toLocaleString()}
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              {' '}
              ({mobilityStats.activeAgents.toLocaleString()} units)
            </span>
          </div>
        </div>

        <div className="metric-box">
          <div className="metric-label">Traffic Delay (TTI)</div>
          <div className="metric-value" style={{ fontSize: 13, color: ttiColor }}>
            {mobilityStats.loaded ? `${tti.toFixed(2)}×` : '—'}
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              {' '}
              · {mobilityStats.avgTripMin > 0 ? `${mobilityStats.avgTripMin.toFixed(1)}m` : ''}
            </span>
          </div>
        </div>

        <div className="metric-box">
          <div className="metric-label">Jammed Links</div>
          <div className="metric-value" style={{ fontSize: 13 }}>
            {mobilityCongestionEnabled ? mobilityStats.congestedEdgeCount.toLocaleString() : '0'}
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 500,
                color: 'var(--text-muted)',
              }}
            >
              {' '}
              V/C≥0.85
            </span>
          </div>
        </div>

        <div className="metric-box">
          <div className="metric-label">Peak Link V/C</div>
          <div className="metric-value" style={{ fontSize: 13 }}>
            {mobilityCongestionEnabled ? `${mobilityStats.peakVcRatio.toFixed(2)}` : 'Free-flow'}
          </div>
        </div>

        {selectedBarangayName && (
          <div className="metric-box" style={{ gridColumn: '1 / -1' }}>
            <div className="metric-label">{selectedBarangayName} Out/In</div>
            <div className="metric-value" style={{ fontSize: 13 }}>
              {mobilityStats.selectedBarangayOutbound.toLocaleString()}
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--text-muted)',
                }}
              >
                {' '}
                / {mobilityStats.selectedBarangayInbound.toLocaleString()}
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="layer-card">
        <div className="layer-row">
          <span style={{ fontWeight: 600, fontSize: 12 }}>
            Road Congestion (BPR)
          </span>
          <input
            type="checkbox"
            switch=""
            checked={mobilityCongestionEnabled}
            aria-label="Toggle road congestion physics"
            onChange={(e) => setMobilityCongestionEnabled(e.target.checked)}
          />
        </div>

        <div className="layer-row">
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            Show Congested Roads
          </span>
          <input
            type="checkbox"
            switch=""
            checked={mobilityShowCongestedRoads}
            disabled={!mobilityCongestionEnabled}
            aria-label="Toggle congested road ribbons"
            onChange={(e) => setMobilityShowCongestedRoads(e.target.checked)}
          />
        </div>

        <div className="control-row" style={{ marginTop: 2 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>Color By</span>
          <div className="segmented-control" role="group" aria-label="Particle color mode">
            {COLOR_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`segmented-btn ${mobilityColorMode === opt.value ? 'active' : ''}`}
                aria-pressed={mobilityColorMode === opt.value}
                onClick={() => setMobilityColorMode(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div
          className="control-row"
          style={{
            marginTop: 4,
            paddingTop: 8,
            borderTop: '1px dashed var(--border-subtle)',
          }}
        >
          <span style={{ fontWeight: 600 }}>Traffic Demand Load</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {mobilityCongestionLoad.toFixed(1)}×
          </span>
        </div>
        <MobilityRangeSlider
          value={mobilityCongestionLoad}
          min={0.5}
          max={2.0}
          step={0.1}
          ariaLabel="Traffic demand load scale"
          onChange={setMobilityCongestionLoad}
        />
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          Jeepney = 15–20 pax (2.0 PCU) · Walk = separate sidewalk (0 PCU)
        </span>
      </section>

      <section className="layer-card">
        <h3 className="section-label" style={{ margin: 0 }}>
          Mode Filter Chips (Person Share)
        </h3>
        <div className="choropleth-pills" role="group" aria-label="Travel mode filters">
          {MODE_CHIP_ITEMS.map((item) => {
            const enabled = Boolean(mobilityEnabledModes[item.id]);
            const paxCount =
              mobilityStats.modeTravellers?.[item.id] ?? mobilityStats.modeCounts[item.id] ?? 0;
            const sharePct =
              totalModeTravellers > 0
                ? Math.round((paxCount / totalModeTravellers) * 100)
                : 0;

            return (
              <button
                key={item.id}
                type="button"
                title={item.title}
                className={`pill pill-btn mobility-mode-chip ${
                  enabled ? 'active-pill' : ''
                }`}
                aria-pressed={enabled}
                onClick={() => toggleMobilityMode(item.id)}
                style={!enabled ? { opacity: 0.55 } : undefined}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: item.color,
                    border:
                      item.id === 'walk'
                        ? '1px solid var(--border-strong)'
                        : undefined,
                    flexShrink: 0,
                  }}
                />
                <span>{item.label}</span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    opacity: 0.9,
                  }}
                >
                  {sharePct}%
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="layer-card">
        <div className="control-row">
          <span style={{ fontWeight: 600 }}>Agent Swarm Scale</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {mobilityAgentCount.toLocaleString()}
          </span>
        </div>
        <MobilityRangeSlider
          value={mobilityAgentCount}
          min={2000}
          max={25000}
          step={1000}
          ariaLabel="Agent swarm scale"
          onChange={setMobilityAgentCount}
        />

        <div
          className="control-row"
          style={{
            marginTop: 4,
            paddingTop: 8,
            borderTop: '1px dashed var(--border-subtle)',
          }}
        >
          <span style={{ fontWeight: 600 }}>Gravity Decay (β)</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {mobilityBetaScale.toFixed(1)}×
          </span>
        </div>
        <MobilityRangeSlider
          value={mobilityBetaScale}
          min={0.5}
          max={2.0}
          step={0.1}
          ariaLabel="Gravity decay beta scale"
          onChange={setMobilityBetaScale}
        />
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          Higher β = shorter trips
        </span>

        <div className="control-row" style={{ marginTop: 8 }}>
          <span style={{ fontWeight: 600 }}>Trip Reach (λ)</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {mobilityGravityLambda.toFixed(1)} km
          </span>
        </div>
        <MobilityRangeSlider
          value={mobilityGravityLambda}
          min={1}
          max={12}
          step={0.5}
          ariaLabel="Gravity exponential reach lambda in kilometres"
          onChange={setMobilityGravityLambda}
        />

        <div className="control-row" style={{ marginTop: 8 }}>
          <span style={{ fontWeight: 600 }}>Attraction Source</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
            {Math.round(mobilityAttrBlend * 100)}% buildings
          </span>
        </div>
        <MobilityRangeSlider
          value={mobilityAttrBlend}
          min={0}
          max={1}
          step={0.1}
          ariaLabel="Share of attractions derived from building footprints"
          onChange={setMobilityAttrBlend}
        />
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          0% = survey/zone totals, 100% = footprint-derived jobs, schools and shops
        </span>

        <div className="metrics-grid" style={{ marginTop: 8 }}>
          <div className="metric-box">
            <div className="metric-label">Mean Trip Length</div>
            <div className="metric-value" style={{ fontSize: 12.5 }}>
              {mobilityStats.avgTripKm > 0 ? `${mobilityStats.avgTripKm.toFixed(1)} km` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Target 3–5 km (assumption, not in the Cebu survey)
            </div>
          </div>
          <div className="metric-box">
            <div className="metric-label">Sim Cost</div>
            <div className="metric-value" style={{ fontSize: 12.5 }}>
              {mobilityStats.stepMs > 0 ? `${mobilityStats.stepMs.toFixed(1)} ms/step` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {mobilityStats.spawnsPerStep} new trips this step
            </div>
          </div>
          <div className="metric-box">
            <div className="metric-label">Within One Barangay</div>
            <div className="metric-value" style={{ fontSize: 12.5 }}>
              {mobilityStats.activeAgents > 0
                ? `${(mobilityStats.intraZoneShare * 100).toFixed(0)}%`
                : '—'}
            </div>
          </div>
        </div>
      </section>

      <section className="layer-card">
        <div className="control-row">
          <h3 className="section-label" style={{ margin: 0 }}>
            Barangay O/D Flow Filter
          </h3>
          {selectedBarangayName && (
            <span
              className="pill active-pill"
              style={{
                fontSize: 10.5,
                maxWidth: 150,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={selectedBarangayName}
            >
              <MapPin size={10} style={{ flexShrink: 0 }} />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedBarangayName}
              </span>
            </span>
          )}
        </div>

        <select
          className="text-input"
          style={{ width: '100%', marginBottom: 8 }}
          aria-label="Barangay for origin-destination filter"
          value={selectedBarangayName ?? ''}
          onChange={(e) => {
            const name = e.target.value || null;
            setSelectedBarangayName(name);
            // Choosing a barangay should have an immediate effect: default to showing both directions.
            if (name && mobilityBarangayFilter === 'all') setMobilityBarangayFilter('both');
            const b = name ? barangays.find((x) => x.name === name) : undefined;
            if (b && onFitBounds) onFitBounds(b.bbox);
            if (!name) setMobilityBarangayFilter('all');
          }}
        >
          <option value="">Choose a barangay…</option>
          {(barangayAnalytics?.barangays ?? [])
            .map((b) => b.name)
            .sort((a, b) => a.localeCompare(b))
            .map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
        </select>

        <div
          className="segmented-control"
          style={{ width: '100%' }}
          role="group"
          aria-label="Barangay origin-destination flow filter"
        >
          {BARANGAY_FLOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={!selectedBarangayName}
              className={`segmented-btn ${
                mobilityBarangayFilter === opt.value ? 'active' : ''
              }`}
              style={{ flex: 1 }}
              aria-pressed={mobilityBarangayFilter === opt.value}
              onClick={() => setMobilityBarangayFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {(!selectedBarangayName || mobilityBarangayFilter !== 'all') && (
          <p
            style={{
              margin: 0,
              fontSize: 11,
              color: 'var(--text-muted)',
              lineHeight: 1.35,
            }}
          >
            {selectedBarangayName
              ? 'Orange dots leave this barangay, cyan dots arrive, yellow stay inside it; all other trips are hidden. Choose All to show everything.'
              : 'Pick a barangay above (or click one on the map). Orange dots leave it, cyan dots arrive, yellow stay inside it; everything else hides.'}
          </p>
        )}
      </section>

      <section className="layer-card">
        <div className="control-row">
          <h3 className="section-label" style={{ margin: 0 }}>
            Trip Purpose Breakdown
          </h3>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            {totalPurposeAgents.toLocaleString()}
          </span>
        </div>

        <div className="stacked-bar" aria-hidden="true">
          {PURPOSE_ITEMS.map((item) => {
            const count = mobilityStats.purposeCounts[item.id] ?? 0;
            const widthPct =
              totalPurposeAgents > 0 ? (count / totalPurposeAgents) * 100 : 0;
            return (
              <span
                key={item.id}
                style={{
                  width: `${widthPct}%`,
                  background: item.color,
                }}
                title={`${MOBILITY_PURPOSE_LABELS[item.id]}: ${count.toLocaleString()}`}
              />
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {PURPOSE_ITEMS.map((item) => {
            const count = mobilityStats.purposeCounts[item.id] ?? 0;
            const sharePct =
              totalPurposeAgents > 0
                ? Math.round((count / totalPurposeAgents) * 100)
                : 0;
            return (
              <div key={item.id} className="control-row" style={{ fontSize: 11.5 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: item.color,
                      flexShrink: 0,
                    }}
                  />
                  <span>{MOBILITY_PURPOSE_LABELS[item.id]}</span>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--text-primary)',
                  }}
                >
                  {count.toLocaleString()}{' '}
                  <span style={{ color: 'var(--text-muted)' }}>({sharePct}%)</span>
                </span>
              </div>
            );
          })}
        </div>

        {selectedBarangayName && (
          <div className="purpose-local">
            <div className="control-row">
              <h4 className="section-label" style={{ margin: 0 }}>
                Residents of {selectedBarangayName}
              </h4>
              {selectedZone?.area_type && (
                <span className="pill" title="Area type from the barangay classifier">
                  {selectedZone.area_type.label}
                </span>
              )}
            </div>
            {PURPOSE_ITEMS.map((item) => {
              const live = mobilityStats.selectedBarangayPurposes?.[item.id] ?? 0;
              // A few trips say little: show the live share only once the sample is meaningful.
              const liveSharePct = totalSelectedPurposes >= 20 ? Math.round((live / totalSelectedPurposes) * 100) : null;
              const expected = selectedZone?.purpose_mix?.[item.id];
              const cityPct =
                totalPurposeAgents > 0
                  ? Math.round(((mobilityStats.purposeCounts[item.id] ?? 0) / totalPurposeAgents) * 100)
                  : null;
              return (
                <div key={item.id} className="control-row" style={{ fontSize: 11.5 }}>
                  <span>{MOBILITY_PURPOSE_LABELS[item.id]}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {expected !== undefined ? `${Math.round(expected * 100)}%` : '–'}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}expected · now {liveSharePct === null ? '–' : `${liveSharePct}%`} · city {cityPct ?? '–'}%
                    </span>
                  </span>
                </div>
              );
            })}
            <p style={{ margin: 0, fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.35 }}>
              Expected mix comes from residents&apos; age (PSA 2020) and Cebu household survey trip rates; the
              age-to-purpose split is an assumption.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
