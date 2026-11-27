import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Layers,
  Mountain,
  Plus,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTwinStore } from '../layers/registry';
import type {
  BuildingClassConfidenceFilter,
  BuildingColorMode,
  LayerCategory,
  TwinLayerDefinition,
} from '../layers/types';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    switch?: string | boolean;
  }
}

interface LayerDockProps {
  onOpenAddModal: () => void;
  /** Phones: the dock is a bottom sheet that is shown only while this is true. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

const CATEGORY_LABELS: Record<LayerCategory, string> = {
  base: 'Base & Urban Form',
  infrastructure: 'Infrastructure',
  civic: 'Civic & Heritage',
  environment: 'Environment & Terrain',
  mobility: 'Mobility',
  sensors: 'Sensors',
  custom: 'Custom Overlays',
};

const CATEGORY_ORDER: LayerCategory[] = [
  'base',
  'infrastructure',
  'civic',
  'environment',
  'mobility',
  'sensors',
  'custom',
];

const COLOR_MODES: Array<{ value: BuildingColorMode; label: string }> = [
  { value: 'height', label: 'Height' },
  { value: 'source', label: 'Source' },
  { value: 'class', label: 'Class' },
  { value: 'clay', label: 'Clay' },
];

const CONFIDENCE_FILTERS: Array<{
  value: BuildingClassConfidenceFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'hide_inferred', label: 'No Inferred' },
  { value: 'verified_only', label: 'Verified' },
];

function formatSunHour(hour: number): string {
  const wholeHours = Math.floor(hour);
  const mins = Math.round((hour - wholeHours) * 60);
  const hh = String(wholeHours).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface RangeSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}

function RangeSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  onChange,
}: RangeSliderProps) {
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

export function LayerDock({ onOpenAddModal, mobileOpen = false, onMobileClose }: LayerDockProps) {
  const {
    layers,
    layerState,
    buildingColorMode,
    setBuildingColorMode,
    buildingConfidenceFilter,
    setBuildingConfidenceFilter,
    terrainEnabled,
    setTerrainEnabled,
    terrainExaggeration,
    setTerrainExaggeration,
    sunHour,
    setSunHour,
    googleMapsApiKey,
    setGoogleMapsApiKey,
    toggleLayer,
    setOpacity,
    updateLayerStyle,
    unregisterLayer,
  } = useTwinStore();

  const [collapsed, setCollapsed] = useState(false);
  const [expandedStyleIds, setExpandedStyleIds] = useState<Record<string, boolean>>({});
  const [keyDraft, setKeyDraft] = useState(googleMapsApiKey);

  const toggleStyleEditor = (layerId: string) => {
    setExpandedStyleIds((prev) => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  // The mobility layer is driven by the Simulate view, not the layer list.
  const grouped = CATEGORY_ORDER.filter((category) => category !== 'mobility').map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: layers.filter((layer) => layer.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <aside
      className={`hud-dock glass-panel ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}
      aria-label="Layers and environment controls"
    >
      <div className="hud-dock-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Layers size={15} style={{ color: 'var(--accent)' }} />
          {!collapsed && (
            <span style={{ fontWeight: 700, fontSize: 13 }}>
              Layers &amp; Scene
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-icon btn-ghost mobile-only"
          onClick={onMobileClose}
          aria-label="Close layers"
        >
          <X size={16} />
        </button>
        <button
          type="button"
          className="btn btn-icon btn-ghost desktop-only"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand layer dock' : 'Collapse layer dock'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>

      {!collapsed && (
        <div className="hud-dock-body scrollable-panel">
          {/* Building Color Mode */}
          <section>
            <h3 className="section-label">Building Color Mode</h3>
            <div
              className="segmented-control"
              style={{ width: '100%' }}
              role="group"
              aria-label="Building color mode"
            >
              {COLOR_MODES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`segmented-btn ${
                    buildingColorMode === item.value ? 'active' : ''
                  }`}
                  style={{ flex: 1 }}
                  onClick={() => setBuildingColorMode(item.value)}
                  aria-pressed={buildingColorMode === item.value}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {buildingColorMode === 'class' && (
              <div style={{ marginTop: 8 }}>
                <div className="control-row" style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    Class Confidence
                  </span>
                </div>
                <div
                  className="segmented-control"
                  style={{ width: '100%' }}
                  role="group"
                  aria-label="Building class confidence filter"
                >
                  {CONFIDENCE_FILTERS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`segmented-btn ${
                        buildingConfidenceFilter === item.value ? 'active' : ''
                      }`}
                      style={{ flex: 1, fontSize: 11 }}
                      onClick={() => setBuildingConfidenceFilter(item.value)}
                      aria-pressed={buildingConfidenceFilter === item.value}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* 3D Terrain & Sun Lighting */}
          <section className="layer-card">
            <div className="layer-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Mountain size={14} style={{ color: 'var(--accent)' }} />
                <span className="layer-title">3D Terrain</span>
              </div>
              <input
                type="checkbox"
                switch=""
                checked={terrainEnabled}
                aria-label="Toggle 3D Terrain"
                onChange={(e) => setTerrainEnabled(e.target.checked)}
              />
            </div>

            <div className="control-row">
              <span>Exaggeration</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {terrainExaggeration.toFixed(1)}×
              </span>
            </div>
            <RangeSlider
              value={terrainExaggeration}
              min={0}
              max={3}
              step={0.1}
              ariaLabel="Terrain exaggeration"
              onChange={setTerrainExaggeration}
            />

            <div
              className="control-row"
              style={{ marginTop: 4, paddingTop: 6, borderTop: '1px dashed var(--border-subtle)' }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Sun size={13} style={{ color: 'var(--warning)' }} />
                Sun Time
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {formatSunHour(sunHour)}
              </span>
            </div>
            <RangeSlider
              value={sunHour}
              min={6}
              max={19}
              step={0.25}
              ariaLabel="Sun time of day"
              onChange={setSunHour}
            />

            <div
              style={{
                marginTop: 6,
                paddingTop: 8,
                borderTop: '1px dashed var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div className="control-row">
                <span>Satellite Imagery</span>
                <span className="pill">
                  {googleMapsApiKey.trim()
                    ? 'Google 2D Tiles'
                    : 'Esri (z18 max)'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  type="password"
                  className="text-input"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Google Map Tiles API key"
                  aria-label="Google Map Tiles API key"
                  style={{ flex: 1, minWidth: 0, height: 28, fontSize: 11 }}
                />
                <button
                  type="button"
                  className="btn"
                  style={{ height: 28, padding: '0 8px', fontSize: 11 }}
                  onClick={() => setGoogleMapsApiKey(keyDraft.trim())}
                >
                  Save
                </button>
                {googleMapsApiKey.trim() && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ height: 28, padding: '0 6px', fontSize: 11 }}
                    onClick={() => {
                      setKeyDraft('');
                      setGoogleMapsApiKey('');
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3 }}>
                Optional Google Map Tiles API key (100k free tiles/mo; stored locally).
              </span>
            </div>
          </section>

          {/* Layer Groups */}
          {grouped.map((group) => (
            <section key={group.category} className="layer-group">
              <h3 className="section-label">{group.label}</h3>
              {group.items.map((layer: TwinLayerDefinition) => {
                const entry = layerState[layer.id] ?? {
                  visible: layer.defaultVisible,
                  opacity: layer.defaultOpacity,
                  style: layer.defaultStyle,
                };
                const styleExpanded = Boolean(expandedStyleIds[layer.id]);
                const activeStyle = entry.style ?? layer.defaultStyle;

                return (
                  <div key={layer.id} className="layer-card">
                    <div className="layer-row">
                      <div style={{ minWidth: 0 }}>
                        <div className="layer-title">{layer.name}</div>
                        <div className="layer-desc">{layer.description}</div>
                      </div>
                      <input
                        type="checkbox"
                        switch=""
                        checked={entry.visible}
                        aria-label={`Toggle ${layer.name}`}
                        onChange={(e) => toggleLayer(layer.id, e.target.checked)}
                      />
                    </div>

                    {entry.visible && (
                      <>
                        <div className="control-row">
                          <span>Opacity</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            {Math.round(entry.opacity * 100)}%
                          </span>
                        </div>
                        <RangeSlider
                          value={entry.opacity}
                          min={0}
                          max={1}
                          step={0.05}
                          ariaLabel={`${layer.name} opacity`}
                          onChange={(val) => setOpacity(layer.id, val)}
                        />
                      </>
                    )}

                    {layer.removable && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 6,
                          paddingTop: 2,
                        }}
                      >
                        <button
                          type="button"
                          className="btn"
                          style={{ height: 26, fontSize: 11 }}
                          onClick={() => toggleStyleEditor(layer.id)}
                          aria-expanded={styleExpanded}
                        >
                          <SlidersHorizontal size={12} />
                          Style
                          {styleExpanded ? (
                            <ChevronUp size={12} />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-icon"
                          style={{ width: 26, height: 26 }}
                          onClick={() => unregisterLayer(layer.id)}
                          aria-label={`Remove ${layer.name}`}
                          title="Remove layer"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}

                    {layer.removable && styleExpanded && activeStyle && (
                      <div className="layer-style-editor">
                        <div className="control-row">
                          <label htmlFor={`fill-${layer.id}`}>Fill Color</label>
                          <input
                            id={`fill-${layer.id}`}
                            type="color"
                            value={activeStyle.fillColor}
                            onChange={(e) =>
                              updateLayerStyle(layer.id, {
                                fillColor: e.target.value,
                                lineColor: e.target.value,
                              })
                            }
                            style={{
                              width: 34,
                              height: 24,
                              padding: 0,
                              border: '1px solid var(--border-subtle)',
                              borderRadius: 'var(--radius-xs)',
                              background: 'transparent',
                              cursor: 'pointer',
                            }}
                          />
                        </div>

                        <div className="control-row">
                          <span>Line Width</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            {activeStyle.lineWidth.toFixed(1)} px
                          </span>
                        </div>
                        <RangeSlider
                          value={activeStyle.lineWidth}
                          min={0.5}
                          max={8}
                          step={0.5}
                          ariaLabel={`${layer.name} line width`}
                          onChange={(val) =>
                            updateLayerStyle(layer.id, { lineWidth: val })
                          }
                        />

                        <div className="control-row">
                          <span>3D Extruded</span>
                          <input
                            type="checkbox"
                            switch=""
                            checked={activeStyle.extruded}
                            aria-label={`Extrude ${layer.name}`}
                            onChange={(e) =>
                              updateLayerStyle(layer.id, {
                                extruded: e.target.checked,
                              })
                            }
                          />
                        </div>

                        {activeStyle.extruded && (
                          <>
                            <label
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4,
                              }}
                            >
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                Elevation Property
                              </span>
                              <select
                                className="select-input"
                                value={activeStyle.elevationProperty ?? ''}
                                onChange={(e) =>
                                  updateLayerStyle(layer.id, {
                                    elevationProperty: e.target.value || null,
                                  })
                                }
                              >
                                <option value="">Uniform (10 m × scale)</option>
                                {(layer.numericProperties ?? []).map((prop) => (
                                  <option key={prop} value={prop}>
                                    {prop}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <div className="control-row">
                              <span>Elevation Scale</span>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                                {activeStyle.elevationScale.toFixed(1)}×
                              </span>
                            </div>
                            <RangeSlider
                              value={activeStyle.elevationScale}
                              min={0.5}
                              max={20}
                              step={0.5}
                              ariaLabel={`${layer.name} elevation scale`}
                              onChange={(val) =>
                                updateLayerStyle(layer.id, { elevationScale: val })
                              }
                            />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          <button
            type="button"
            className="btn btn-primary"
            onClick={onOpenAddModal}
            style={{ width: '100%', justifyContent: 'center', marginTop: 2 }}
          >
            <Plus size={14} />
            Add GeoJSON / PMTiles
          </button>
        </div>
      )}
    </aside>
  );
}
