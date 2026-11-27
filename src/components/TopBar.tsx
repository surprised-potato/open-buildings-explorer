import {
  Building2,
  Check,
  Compass,
  MapPin,
  Ruler,
  Search,
  Share2,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { placeLandmarks } from '../layers/builtins';
import { getPlaceMeta, type CameraPreset } from '../utils/place';
import { useTwinStore } from '../layers/registry';
import type { BasemapTheme, SearchablePlaceItem } from '../layers/types';
import type { MeasureMode } from './MeasureControl';
import { ViewSwitcher } from './ViewSwitcher';

export type { CameraPreset } from '../utils/place';

interface TopBarProps {
  measureMode: MeasureMode;
  onToggleMeasure: () => void;
  onFlyTo: (camera: {
    center: [number, number];
    zoom?: number;
    pitch?: number;
    bearing?: number;
  }) => void;
  onFitBounds: (bbox: [number, number, number, number]) => void;
  onNotify: (message: string) => void;
}

interface SearchOption {
  id: string;
  label: string;
  subtitle: string;
  kind: 'landmark' | 'barangay' | 'city' | 'place';
  camera?: CameraPreset | { center: [number, number]; zoom: number; pitch: number; bearing: number };
  bbox?: [number, number, number, number];
  place?: SearchablePlaceItem;
}

const THEMES: Array<{ value: BasemapTheme; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'satellite', label: 'Satellite' },
];

export function TopBar({
  measureMode,
  onToggleMeasure,
  onFlyTo,
  onFitBounds,
  onNotify,
}: TopBarProps) {
  const {
    manifest,
    barangays,
    barangayAnalytics,
    buildingPois,
    searchablePlaces,
    theme,
    setTheme,
    selectedFeature,
    setSelectedFeature,
    selectedBarangayName,
    setSelectedBarangayName,
  } = useTwinStore();

  const [query, setQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  const searchOptions = useMemo<SearchOption[]>(() => {
    const q = query.trim().toLowerCase();

    const landmarkMatches: SearchOption[] = placeLandmarks().filter(
      (lm) =>
        !q ||
        lm.name.toLowerCase().includes(q) ||
        lm.category.toLowerCase().includes(q)
    ).map((lm) => ({
      id: `lm-${lm.id}`,
      label: lm.name,
      subtitle: lm.category,
      kind: 'landmark',
      camera: lm.camera,
    }));

    const barangayMatches: SearchOption[] = barangays
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .map((b) => ({
        id: `brgy-${b.id}`,
        label: b.name,
        subtitle: b.level === 'city' ? 'City Boundary' : 'Barangay',
        kind: b.level === 'city' ? 'city' : 'barangay',
        bbox: b.bbox,
      }));

    const placeMatches: SearchOption[] = (
      q ? searchablePlaces : searchablePlaces.slice(0, 15)
    )
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (p.buildingName && p.buildingName.toLowerCase().includes(q)) ||
          p.category.toLowerCase().includes(q) ||
          p.tag.toLowerCase().includes(q)
      )
      .slice(0, 20)
      .map((p) => {
        const srcLabel =
          p.source === 'foursquare'
            ? 'Foursquare'
            : p.source === 'overture'
              ? 'Overture'
              : 'OSM';
        return {
          id: `place-${p.buildingId}-${p.poiId}`,
          label: p.name,
          subtitle: `${p.category} · ${p.buildingClass.replace(/_/g, ' ')} · ${srcLabel}`,
          kind: 'place' as const,
          camera: {
            center: p.coordinates,
            zoom: 17.2,
            pitch: 58,
            bearing: -18,
          },
          place: p,
        };
      });

    return [...landmarkMatches, ...barangayMatches, ...placeMatches].slice(0, 35);
  }, [query, barangays, searchablePlaces]);

  const handleSelectOption = (opt: SearchOption) => {
    setQuery(opt.label);
    setDropdownOpen(false);
    if (opt.place && opt.camera) {
      onFlyTo(opt.camera);
      const place = opt.place;
      const host = buildingPois[place.buildingId];
      setSelectedFeature({
        layerId: 'buildings',
        layerName: '3D Buildings',
        id: place.buildingId,
        coordinates: place.coordinates,
        highlightedPoiId: place.poiId,
        properties: host
          ? {
              id: host.id,
              name: host.name,
              bclass: host.bclass,
              class_source: host.class_source,
              effective_height: host.effective_height,
              height_source: host.height_source,
              num_floors: host.num_floors,
              area_m2: host.area_m2,
              primary_source: host.primary_source,
              poi_count: host.poi_count,
              poi_names: host.poi_names,
              poi_tags: host.poi_tags,
              poi_match_distance_m: host.poi_match_distance_m,
            }
          : {
              id: place.buildingId,
              name: place.buildingName ?? place.name,
              bclass: place.buildingClass,
            },
      });
    } else if (opt.camera) {
      onFlyTo(opt.camera);
      const lm = placeLandmarks().find((item) => `lm-${item.id}` === opt.id);
      if (lm) {
        setSelectedFeature({
          layerId: 'landmarks',
          layerName: 'Civic Landmarks',
          id: lm.id,
          coordinates: lm.coordinates,
          properties: {
            id: lm.id,
            name: lm.name,
            category: lm.category,
            description: lm.description,
            longitude: lm.coordinates[0],
            latitude: lm.coordinates[1],
          },
        });
      }
    } else if (opt.bbox) {
      onFitBounds(opt.bbox);
      if (opt.kind === 'barangay') {
        setSelectedBarangayName(opt.label);
        const brgyIdx = barangays.find(
          (b) => b.name === opt.label && b.level === 'barangay'
        );
        const brgyStats = barangayAnalytics?.barangays.find(
          (b) => b.name === opt.label
        );
        setSelectedFeature({
          layerId: 'boundaries',
          layerName: 'Barangay Boundaries',
          id: brgyIdx?.id ?? opt.id,
          coordinates: brgyStats?.centroid ?? brgyIdx?.centroid,
          properties: {
            name: opt.label,
            level: 'barangay',
            ...(brgyStats
              ? {
                  area_km2: brgyStats.area_km2,
                  building_count: brgyStats.building_count,
                  building_density_per_km2: brgyStats.building_density_per_km2,
                  commercial_count: brgyStats.commercial_count,
                  commercial_share_pct: brgyStats.commercial_share_pct,
                  poi_count: brgyStats.poi_count,
                  built_coverage_pct: brgyStats.built_coverage_pct,
                  mean_elev_m: brgyStats.mean_elev_m,
                  green_space_pct: brgyStats.green_space_pct,
                }
              : {}),
          },
        });
      } else if (opt.kind === 'city') {
        setSelectedBarangayName(null);
      }
    }
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedShare(true);
      onNotify('Shareable 3D camera link copied to clipboard');
      window.setTimeout(() => setCopiedShare(false), 2000);
    } catch {
      onNotify('URL hash updated — copy link from address bar');
    }
  };

  const countsSummary = useMemo(() => {
    if (!manifest) return null;
    const total = manifest.counts.buildings || 0;
    const pctMeasured =
      total > 0 ? Math.round((manifest.counts.buildings_measured / total) * 100) : 0;
    const pctFloors =
      total > 0 ? Math.round((manifest.counts.buildings_floors / total) * 100) : 0;
    const pctEstimated = Math.max(0, 100 - pctMeasured - pctFloors);
    return {
      total,
      pctMeasured,
      pctFloors,
      pctEstimated,
      barangays: manifest.counts.barangays,
      linkedPlaces:
        manifest.counts.pois_matched ?? manifest.counts.osm_pois_matched,
      commercial: manifest.counts.buildings_commercial,
    };
  }, [manifest]);

  return (
    <header className="hud-topbar glass-panel">
      <div className="hud-topbar-left">
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent)',
            flexShrink: 0,
          }}
        >
          <Building2 size={17} />
        </div>
        <div className="hud-topbar-brand">
          <h1 className="hud-topbar-title">{getPlaceMeta().displayName}</h1>
          <span className="hud-topbar-subtitle">
            3D Graphical Digital Twin · Overture {manifest?.overture_release ?? '2026-11-18.0'}
          </span>
        </div>

        {countsSummary && (
          <div
            className="pill"
            title={`Measured (${countsSummary.pctMeasured}%) / Floors (${countsSummary.pctFloors}%) / Estimated (${countsSummary.pctEstimated}%) heights`}
          >
            <strong>{countsSummary.total.toLocaleString()}</strong> buildings
            {typeof countsSummary.commercial === 'number' && countsSummary.commercial > 0 && (
              <> · <strong>{countsSummary.commercial.toLocaleString()}</strong> commercial</>
            )}
            {typeof countsSummary.linkedPlaces === 'number' && countsSummary.linkedPlaces > 0 && (
              <> · <strong>{countsSummary.linkedPlaces.toLocaleString()}</strong> linked places</>
            )}
          </div>
        )}
      </div>

      <div className="hud-topbar-center" style={{ flexWrap: 'wrap' }}>
        <div
          ref={searchContainerRef}
          className="search-combobox"
          onBlur={(e) => {
            if (!searchContainerRef.current?.contains(e.relatedTarget as Node | null)) {
              setDropdownOpen(false);
            }
          }}
        >
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: 9,
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }}
            />
            <input
              type="text"
              role="combobox"
              aria-expanded={dropdownOpen}
              aria-controls="place-search-listbox"
              aria-label="Search barangay or landmark"
              className="text-input"
              style={{ paddingLeft: 28, paddingRight: query ? 26 : 9 }}
              placeholder={`Search ${barangays.length || 61} barangays & places…`}
              value={query}
              onFocus={() => setDropdownOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setDropdownOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchOptions.length > 0) {
                  e.preventDefault();
                  handleSelectOption(searchOptions[0]);
                } else if (e.key === 'Escape') {
                  setDropdownOpen(false);
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="btn-ghost"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  setDropdownOpen(true);
                }}
                style={{
                  position: 'absolute',
                  right: 6,
                  border: 'none',
                  background: 'transparent',
                  padding: 2,
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  display: 'flex',
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {dropdownOpen && searchOptions.length > 0 && (
            <div
              id="place-search-listbox"
              role="listbox"
              className="search-results scrollable-panel"
            >
              {searchOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="search-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectOption(opt);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {opt.kind === 'landmark' || opt.kind === 'place' ? (
                      <MapPin
                        size={12}
                        style={{
                          color:
                            opt.kind === 'place'
                              ? 'var(--success)'
                              : 'var(--warning)',
                        }}
                      />
                    ) : (
                      <Compass size={12} style={{ color: 'var(--accent)' }} />
                    )}
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{opt.label}</span>
                  </span>
                  <span className="pill" style={{ fontSize: 10 }}>
                    {opt.subtitle}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedBarangayName && (
          <div className="active-barangay-chip" title="Highlighted barangay">
            <button
              type="button"
              className="active-barangay-focus"
              onClick={() => {
                const match = barangays.find(
                  (b) => b.name === selectedBarangayName && b.level === 'barangay'
                );
                if (match) {
                  onFitBounds(match.bbox);
                }
              }}
            >
              <span className="active-barangay-dot" aria-hidden="true" />
              <span>{selectedBarangayName}</span>
            </button>
            <button
              type="button"
              className="active-barangay-clear"
              aria-label="Clear barangay highlight"
              title="Clear barangay highlight"
              onClick={() => {
                setSelectedBarangayName(null);
                if (selectedFeature?.layerId === 'boundaries') {
                  setSelectedFeature(null);
                }
              }}
            >
              <X size={11} />
            </button>
          </div>
        )}

        <nav
          aria-label="Camera presets"
          style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
        >
          {getPlaceMeta().cameraPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="pill pill-btn"
              onClick={() => onFlyTo(preset)}
            >
              {preset.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="hud-topbar-right">
        <ViewSwitcher />
        <div className="segmented-control" role="group" aria-label="Basemap theme">
          {THEMES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`segmented-btn ${theme === item.value ? 'active' : ''}`}
              onClick={() => setTheme(item.value)}
              aria-pressed={theme === item.value}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`btn ${measureMode !== 'off' ? 'active' : ''}`}
          onClick={onToggleMeasure}
          aria-pressed={measureMode !== 'off'}
          title="Measure distance, area, and elevation profile"
        >
          <Ruler size={13} />
          Measure
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => void handleShare()}
          title="Copy shareable 3D view link"
        >
          {copiedShare ? <Check size={13} /> : <Share2 size={13} />}
          {copiedShare ? 'Copied' : 'Share'}
        </button>
      </div>
    </header>
  );
}
