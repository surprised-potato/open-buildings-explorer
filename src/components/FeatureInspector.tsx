import { getActiveSimulation } from '../utils/mobilitySim';
import { loadBuildingHazard, lookupBuildingHazard, type BuildingHazard } from '../utils/buildingHazard';
import { buildGersIndex, gersKey } from '../reports/tripGeneration';
import type { MobilityBuildings } from '../utils/mobilityTypes';
import {
  ArrowRight,
  Check,
  Copy,
  Crosshair,
  ExternalLink,
  Info,
  MapPin,
  Mountain,
  Navigation,
  Store,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTwinStore } from '../layers/registry';
import type { BuildingPoiItem } from '../layers/types';
import { formatElevation } from '../utils/demSampler';
import { formatArea } from '../utils/geometry';
import {
  estimateBuildingValue,
  landUseGroup,
  loadBuildingZonal,
  lookupBuildingZonal,
  type BuildingZonalEstimate,
} from '../utils/buildingZonal';
import { MOBILITY_MODE_HEX, type MobilityModeId } from '../utils/mobilityTypes';

const CATEGORY_COLORS: Record<string, string> = {
  commercial: '#f59e0b',
  retail: '#fb923c',
  food: '#f97316',
  hotel: '#fbbf24',
  office: '#818cf8',
  healthcare: '#f43f5e',
  education: '#2dd4bf',
  civic: '#34d399',
  religious: '#e879f9',
  industrial: '#a78bfa',
  leisure: '#38bdf8',
  other: '#94a3b8',
};

function formatPhp(v: number): string {
  if (v >= 1e9) return `₱${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `₱${(v / 1e6).toFixed(1)}M`;
  return `₱${Math.round(v / 1e3).toLocaleString('en-PH')}K`;
}

function formatPhpFull(v: number): string {
  return `₱${Math.round(v).toLocaleString('en-PH')}`;
}

function formatClassLabel(bclass: string): string {
  if (bclass === 'mixed_use') return 'Mixed-Use';
  return bclass
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

function formatHeightSourceBadge(source: unknown): {
  label: string;
  className: string;
} | null {
  if (source === 'measured') {
    return { label: 'Measured', className: 'badge badge-measured' };
  }
  if (source === 'floors') {
    return { label: 'From Floors', className: 'badge badge-floors' };
  }
  if (source === 'estimated') {
    return { label: 'Estimated', className: 'badge badge-estimated' };
  }
  return null;
}

function formatClassSourceBadge(source: unknown): {
  label: string;
  className: string;
} | null {
  if (source === 'osm_poi_inside') {
    return { label: 'OSM POI (Inside)', className: 'badge badge-osm-poi' };
  }
  if (source === 'osm_poi_nearest') {
    return { label: 'OSM POI (Nearest)', className: 'badge badge-osm-poi' };
  }
  if (source === 'overture_poi_inside') {
    return { label: 'Overture Place (Inside)', className: 'badge badge-overture-poi' };
  }
  if (source === 'overture_poi_nearest') {
    return { label: 'Overture Place (Nearest)', className: 'badge badge-overture-poi' };
  }
  if (source === 'foursquare_poi_inside') {
    return { label: 'Foursquare (Inside)', className: 'badge badge-foursquare-poi' };
  }
  if (source === 'foursquare_poi_nearest') {
    return { label: 'Foursquare (Nearest)', className: 'badge badge-foursquare-poi' };
  }
  if (source === 'osm_landuse') {
    return { label: 'OSM Land Use', className: 'badge badge-landuse' };
  }
  if (source === 'osm_compound') {
    return { label: 'OSM Compound', className: 'badge badge-osm-poi' };
  }
  if (source === 'name_keyword') {
    return { label: 'Building Name', className: 'badge badge-osm-poi' };
  }
  if (source === 'morph_arterial') {
    return { label: 'Inferred · Arterial', className: 'badge badge-inferred' };
  }
  if (source === 'morph_industrial') {
    return { label: 'Inferred · Industrial', className: 'badge badge-inferred' };
  }
  if (source === 'morph_residential') {
    return { label: 'Inferred · Residential', className: 'badge badge-inferred' };
  }
  if (source === 'overture') {
    return { label: 'Overture', className: 'badge badge-floors' };
  }
  return null;
}

function formatClassConfidenceBadge(confidence: unknown): {
  label: string;
  className: string;
} | null {
  if (confidence === 'verified') {
    return { label: 'Verified', className: 'badge badge-confidence-verified' };
  }
  if (confidence === 'medium') {
    return { label: 'Medium', className: 'badge badge-confidence-medium' };
  }
  if (confidence === 'inferred') {
    return { label: 'Inferred', className: 'badge badge-confidence-inferred' };
  }
  return null;
}

function formatPoiSourcePill(
  source?: string,
  confidence?: number | null
): string {
  if (source === 'foursquare') {
    return typeof confidence === 'number'
      ? `Foursquare · ${Math.round(confidence * 100)}%`
      : 'Foursquare';
  }
  if (source === 'overture') {
    return typeof confidence === 'number'
      ? `Overture · ${Math.round(confidence * 100)}%`
      : 'Overture';
  }
  return 'OSM';
}

function formatPropValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function PoiCard({
  poi,
  highlighted,
  buildingCenter,
}: {
  poi: BuildingPoiItem;
  highlighted: boolean;
  buildingCenter?: [number, number] | null;
}) {
  const catColor = CATEGORY_COLORS[poi.category] ?? CATEGORY_COLORS.other;
  const displayName = poi.name?.trim() || `${poi.poi_key}=${poi.poi_value}`;
  const matchLabel =
    poi.match_method === 'inside'
      ? 'Inside'
      : `Nearest · ${poi.match_distance_m.toFixed(1)}m`;

  const metaParts: string[] = [];
  if (poi.brand && poi.brand !== poi.name) metaParts.push(poi.brand);
  if (poi.cuisine) metaParts.push(poi.cuisine.replace(/;/g, ', '));
  if (poi.addr_street) metaParts.push(poi.addr_street);
  if (poi.phone) metaParts.push(poi.phone);

  const safeWebsite =
    poi.website && /^https?:\/\//i.test(poi.website) ? poi.website : null;

  const googleMapsUrl = poi.name?.trim()
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${poi.name.trim()} Bacolod City`)}`
    : buildingCenter
      ? `https://www.google.com/maps/search/?api=1&query=${buildingCenter[1].toFixed(6)},${buildingCenter[0].toFixed(6)}`
      : null;

  return (
    <div className={`poi-card ${highlighted ? 'highlighted' : ''}`}>
      <div className="poi-card-header">
        <span className="poi-card-name">{displayName}</span>
        <span
          className={`badge ${
            poi.match_method === 'inside' ? 'badge-measured' : 'badge-osm-poi'
          }`}
        >
          {matchLabel}
        </span>
      </div>

      <div className="poi-card-tags">
        <span
          className="poi-cat-pill"
          style={{
            borderColor: catColor,
            color: catColor,
          }}
        >
          <span
            className="poi-cat-dot"
            style={{ backgroundColor: catColor }}
            aria-hidden="true"
          />
          {poi.category}
        </span>
        <code className="poi-tag">
          {poi.poi_key}={poi.poi_value}
        </code>
        <span
          className="poi-source-pill"
          title={poi.updated ? `Updated ${poi.updated}` : undefined}
        >
          {formatPoiSourcePill(poi.source, poi.confidence)}
          {poi.updated ? ` · ${poi.updated.slice(0, 7)}` : ''}
        </span>
        {poi.trust === 'unverified' && (
          <span
            className="poi-source-pill"
            style={{ borderColor: '#f59e0b', color: '#f59e0b' }}
            title={`Location may be wrong. Votes: ${(poi.votes ?? []).join(', ')} (street/barangay vs pin, duplicate phone elsewhere, source)`}
          >
            Location unverified
          </span>
        )}
        {poi.trust === 'verified' && (
          <span
            className="poi-source-pill"
            title={`Votes: ${(poi.votes ?? []).join(', ')}`}
          >
            ✓ Verified
          </span>
        )}
      </div>

      {(metaParts.length > 0 || safeWebsite || googleMapsUrl) && (
        <div className="poi-card-meta">
          {metaParts.length > 0 && <span>{metaParts.join(' · ')}</span>}
          {safeWebsite && (
            <a
              href={safeWebsite}
              target="_blank"
              rel="noreferrer noopener"
              className="poi-link"
            >
              Website <ExternalLink size={10} />
            </a>
          )}
          {googleMapsUrl && (
            <a
              href={googleMapsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="poi-link"
              title="Spot-check this place in Google Maps"
            >
              Google Maps <ExternalLink size={10} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

interface FeatureInspectorProps {
  onFlyTo?: (camera: {
    center: [number, number];
    zoom?: number;
    pitch?: number;
    bearing?: number;
  }) => void;
}

const gersIndexCache = new WeakMap<MobilityBuildings, Map<string, number>>();

export function FeatureInspector({ onFlyTo }: FeatureInspectorProps = {}) {
  const {
    selectedFeature,
    setSelectedFeature,
    setSelectedBarangayName,
    setSelectedAgentRoute,
    followAgent,
    setFollowAgent,
    sampleElevation,
    buildingPois,
  } = useTwinStore();
  const [copiedId, setCopiedId] = useState(false);
  const [poisExpanded, setPoisExpanded] = useState(false);
  const [valueInfoOpen, setValueInfoOpen] = useState(false);
  const [zonal, setZonal] = useState<BuildingZonalEstimate | null>(null);
  const [hazard, setHazard] = useState<BuildingHazard | null>(null);
  const [tripStat, setTripStat] = useState<{ out: number; in: number; hours: number } | null>(null);

  useEffect(() => {
    setCopiedId(false);
    setPoisExpanded(false);
    setValueInfoOpen(false);
  }, [selectedFeature]);

  useEffect(() => {
    if (selectedFeature?.layerId !== 'mobility') {
      setSelectedAgentRoute(null);
      setFollowAgent(false);
    }
  }, [selectedFeature, setSelectedAgentRoute, setFollowAgent]);

  const props = selectedFeature?.properties ?? {};
  const gersId =
    props.id !== undefined && props.id !== null
      ? String(props.id)
      : selectedFeature?.id !== undefined
        ? String(selectedFeature.id)
        : null;

  const isBuildingFeature = selectedFeature?.layerId === 'buildings';
  useEffect(() => {
    setZonal(null);
    if (!isBuildingFeature || !gersId) return;
    let live = true;
    void loadBuildingZonal(import.meta.env?.BASE_URL ?? '/').then((t) => {
      if (live && t) setZonal(lookupBuildingZonal(t, gersId));
    });
    return () => {
      live = false;
    };
  }, [isBuildingFeature, gersId]);

  useEffect(() => {
    setHazard(null);
    if (!isBuildingFeature || !gersId) return;
    let live = true;
    void loadBuildingHazard(import.meta.env?.BASE_URL ?? '/').then((t) => {
      if (live && t) setHazard(lookupBuildingHazard(t, gersId));
    });
    return () => {
      live = false;
    };
  }, [isBuildingFeature, gersId]);

  // Trips this building has produced / attracted in the running simulation (refreshed every 2 s).
  useEffect(() => {
    setTripStat(null);
    if (!isBuildingFeature || !gersId) return;
    const read = () => {
      const sim = getActiveSimulation();
      const bt = sim?.dataset.buildings;
      if (!sim || !bt) return setTripStat(null);
      let idx = gersIndexCache.get(bt);
      if (!idx) {
        idx = buildGersIndex(bt);
        gersIndexCache.set(bt, idx);
      }
      const i = idx.get(gersKey(gersId));
      if (i === undefined) return setTripStat(null);
      const t = sim.getTripTally();
      setTripStat({ out: t.out[i] ?? 0, in: t.in[i] ?? 0, hours: t.simSec / 3600 });
    };
    read();
    const id = window.setInterval(read, 2000);
    return () => window.clearInterval(id);
  }, [isBuildingFeature, gersId]);

  const hostRecord =
    selectedFeature?.layerId === 'buildings' && gersId
      ? buildingPois[gersId]
      : undefined;

  const attachedPois = useMemo<BuildingPoiItem[]>(() => {
    return hostRecord?.pois ?? [];
  }, [hostRecord]);

  const visiblePois = useMemo<BuildingPoiItem[]>(() => {
    if (poisExpanded || attachedPois.length <= 4) {
      return attachedPois;
    }
    const baseSlice = attachedPois.slice(0, 4);
    const highlightedId = selectedFeature?.highlightedPoiId;
    if (!highlightedId) return baseSlice;
    const match = attachedPois.find((p) => p.osm_id === highlightedId);
    if (!match || baseSlice.some((p) => p.osm_id === highlightedId)) {
      return baseSlice;
    }
    return [match, ...attachedPois.slice(0, 3)];
  }, [attachedPois, poisExpanded, selectedFeature?.highlightedPoiId]);

  if (!selectedFeature) return null;

  const isMobility = selectedFeature.layerId === 'mobility';
  const mobilityOrigin =
    typeof props.origin_barangay === 'string' ? props.origin_barangay : '—';
  const mobilityDest =
    typeof props.dest_barangay === 'string' ? props.dest_barangay : '—';
  const mobilityMode =
    typeof props.mode === 'string' ? (props.mode as MobilityModeId) : null;
  const mobilityModeLabel =
    typeof props.mode_label === 'string'
      ? props.mode_label
      : mobilityMode ?? '—';
  const mobilityPurposeLabel =
    typeof props.purpose_label === 'string'
      ? props.purpose_label
      : typeof props.purpose === 'string'
        ? props.purpose.toUpperCase()
        : '—';
  const mobilitySpeedKmh =
    typeof props.speed_kmh === 'number' ? props.speed_kmh : null;
  const mobilityFreeSpeedKmh =
    typeof props.free_flow_speed_kmh === 'number'
      ? props.free_flow_speed_kmh
      : null;
  const mobilityPassengers =
    typeof props.passengers === 'number' ? props.passengers : 1;
  const mobilityPcu = typeof props.pcu === 'number' ? props.pcu : 0;
  const mobilityLinkVc =
    typeof props.current_link_vc === 'number' ? props.current_link_vc : 0;
  const mobilityChannel =
    props.channel === 'sidewalk' ? 'Sidewalk' : 'Carriageway';
  const mobilityDistanceKm =
    typeof props.distance_km === 'number' ? props.distance_km : null;
  const mobilityDurationMin =
    typeof props.duration_min === 'number' ? props.duration_min : null;
  const mobilityProgressPct =
    typeof props.progress_pct === 'number'
      ? Math.max(0, Math.min(100, props.progress_pct))
      : null;
  const mobilityEtaMin =
    typeof props.eta_min === 'number' ? props.eta_min : null;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const mobilityArrived = props.arrived === true;
  const mobilitySampleScale = num(props.sample_scale);
  const mobilityRepresented = num(props.represented_travellers);
  const mobilityDepartHours = num(props.depart_hours);
  const mobilityElapsedMin = num(props.elapsed_min);
  const mobilityDelayMin = num(props.delay_min);
  const mobilityTravelledKm = num(props.travelled_km);
  const mobilityRemainingKm = num(props.remaining_km);
  const mobilityLinkIndex = num(props.link_index);
  const mobilityLinkCount = num(props.link_count);
  const formatClock = (h: number | null): string => {
    if (h === null) return '—';
    const total = Math.round(h * 60) % 1440;
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const roleLabel = (role: unknown): string =>
    role === 'home'
      ? 'Home'
      : role === 'work'
        ? 'Workplace'
        : role === 'school'
          ? 'School'
          : role === 'other'
            ? 'Errand / leisure'
            : '';
  const endpointBuilding = (prefix: 'origin' | 'dest') => {
    const cls = props[`${prefix}_bldg_class`];
    if (typeof cls !== 'string') return null;
    const name = props[`${prefix}_bldg_name`];
    const area = num(props[`${prefix}_bldg_area_m2`]);
    const access = num(props[`${prefix}_bldg_access_m`]);
    return {
      title:
        typeof name === 'string' && name
          ? name
          : `${cls === 'unknown' ? 'Unclassified' : formatClassLabel(cls)} building`,
      subtitle: [
        typeof name === 'string' && name ? formatClassLabel(cls) : null,
        area !== null ? `${Math.round(area).toLocaleString()} m² footprint` : null,
        access !== null ? `${Math.round(access)} m to road` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      role: roleLabel(props[`${prefix}_bldg_role`]),
      lon: num(props[`${prefix}_bldg_lon`]),
      lat: num(props[`${prefix}_bldg_lat`]),
    };
  };
  const originBldg = endpointBuilding('origin');
  const destBldg = endpointBuilding('dest');
  const mobilityModeColor = mobilityMode
    ? MOBILITY_MODE_HEX[mobilityMode] ?? '#38bdf8'
    : '#38bdf8';

  const bclassLabel =
    typeof props.bclass === 'string' && props.bclass.trim()
      ? props.bclass
      : hostRecord?.bclass ?? null;

  const rawTitle =
    (isMobility
      ? `Traveller #${selectedFeature.id ?? '—'}`
      : null) ||
    (typeof props.name === 'string' && props.name.trim()) ||
    hostRecord?.name ||
    (typeof props.title === 'string' && props.title.trim()) ||
    (bclassLabel && bclassLabel !== 'unknown'
      ? `${formatClassLabel(bclassLabel)} Building`
      : null) ||
    (typeof props.rclass === 'string' && `${props.rclass} road`) ||
    (selectedFeature.id !== undefined
      ? `Feature ${selectedFeature.id}`
      : 'Selected Feature');

  const effectiveHeight =
    typeof props.effective_height === 'number'
      ? props.effective_height
      : typeof props.height === 'number'
        ? props.height
        : hostRecord?.effective_height ?? null;

  const numFloors =
    typeof props.num_floors === 'number'
      ? props.num_floors
      : hostRecord?.num_floors ?? null;
  const areaM2 =
    typeof props.area_m2 === 'number'
      ? props.area_m2
      : hostRecord?.area_m2 ?? null;
  const valueEst =
    zonal && areaM2 !== null
      ? estimateBuildingValue(
          zonal,
          bclassLabel,
          areaM2,
          numFloors ??
            (effectiveHeight !== null ? Math.round(effectiveHeight / 3.2) : null)
        )
      : null;
  const provenance = formatHeightSourceBadge(
    props.height_source ?? hostRecord?.height_source
  );
  const classBadge = formatClassSourceBadge(
    props.class_source ?? hostRecord?.class_source
  );
  const classConfidenceBadge = formatClassConfidenceBadge(
    props.class_confidence ?? hostRecord?.class_confidence
  );

  const poiCount =
    attachedPois.length > 0
      ? attachedPois.length
      : typeof props.poi_count === 'number' && props.poi_count > 0
        ? props.poi_count
        : null;

  const inspectCoords: [number, number] | null = selectedFeature.coordinates
    ? selectedFeature.coordinates
    : hostRecord?.center
      ? hostRecord.center
      : typeof props.longitude === 'number' && typeof props.latitude === 'number'
        ? [props.longitude, props.latitude]
        : null;

  const groundElevation = inspectCoords
    ? sampleElevation(inspectCoords[0], inspectCoords[1])
    : null;

  const coordsLabel = inspectCoords
    ? `${inspectCoords[1].toFixed(5)}, ${inspectCoords[0].toFixed(5)}`
    : null;

  const entries = Object.entries(props).filter(
    ([, val]) => val !== null && val !== undefined && val !== ''
  );

  const handleCopyId = async () => {
    if (!gersId) return;
    try {
      await navigator.clipboard.writeText(gersId);
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1800);
    } catch {
      // Ignore clipboard permission errors in restricted contexts
    }
  };

  return (
    <aside
      className="hud-inspector glass-panel"
      aria-label="Feature inspector"
    >
      <header className="hud-inspector-header">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="pill">{selectedFeature.layerName}</span>
            {provenance && (
              <span className={provenance.className}>{provenance.label}</span>
            )}
            {classBadge && (
              <span className={classBadge.className}>{classBadge.label}</span>
            )}
            {classConfidenceBadge && (
              <span className={classConfidenceBadge.className}>
                {classConfidenceBadge.label}
              </span>
            )}
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--text-primary)',
              wordBreak: 'break-word',
            }}
          >
            {rawTitle}
          </h2>
        </div>

        <button
          type="button"
          className="btn btn-icon btn-ghost"
          onClick={() => {
            if (selectedFeature.layerId === 'boundaries') {
              setSelectedBarangayName(null);
            }
            if (selectedFeature.layerId === 'mobility') {
              setSelectedAgentRoute(null);
              setFollowAgent(false);
            }
            setSelectedFeature(null);
          }}
          aria-label="Close feature inspector"
          title="Close"
        >
          <X size={15} />
        </button>
      </header>

      <div className="hud-inspector-body scrollable-panel">
        {isMobility && (
          <section
            className="analytics-detail-card mobility-traveller-card"
            aria-label="Mobility Traveller"
          >
            <div className="mobility-traveller-route">
              <span className="mobility-traveller-zone">{mobilityOrigin}</span>
              <ArrowRight
                size={13}
                style={{ color: 'var(--accent)', flexShrink: 0 }}
                aria-hidden="true"
              />
              <span className="mobility-traveller-zone">{mobilityDest}</span>
            </div>

            {(originBldg || destBldg) && (
              <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                {[
                  { key: 'from', label: 'From', color: '#4ade80', b: originBldg },
                  { key: 'to', label: 'To', color: '#f87171', b: destBldg },
                ].map(
                  ({ key, label, color, b }) =>
                    b && (
                      <button
                        key={key}
                        type="button"
                        className="metric-box"
                        style={{
                          borderLeft: `3px solid ${color}`,
                          textAlign: 'left',
                          cursor: b.lon !== null && b.lat !== null && onFlyTo ? 'pointer' : 'default',
                          width: '100%',
                          font: 'inherit',
                          color: 'inherit',
                        }}
                        disabled={b.lon === null || b.lat === null || !onFlyTo}
                        title="Fly to this building"
                        aria-label={`Fly to ${label.toLowerCase()} building: ${b.title}`}
                        onClick={() => {
                          if (b.lon === null || b.lat === null || !onFlyTo) return;
                          setFollowAgent(false);
                          onFlyTo({ center: [b.lon, b.lat], zoom: 17.8, pitch: 55 });
                        }}
                      >
                        <div className="metric-label">
                          {label} · {b.role}
                        </div>
                        <div
                          className="metric-value"
                          style={{ fontSize: 12.5, wordBreak: 'break-word' }}
                        >
                          {b.title}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                          {b.subtitle}
                        </div>
                      </button>
                    )
                )}
              </div>
            )}

            <div className="mobility-traveller-badges">
              <span
                className="pill"
                style={{
                  borderColor: mobilityModeColor,
                  color: mobilityModeColor,
                  fontWeight: 600,
                }}
              >
                <span
                  className="poi-cat-dot"
                  style={{ backgroundColor: mobilityModeColor }}
                  aria-hidden="true"
                />
                {mobilityModeLabel}
              </span>
              <span className="pill">
                <Navigation size={10} style={{ color: 'var(--accent)' }} />
                {mobilityPurposeLabel}
              </span>
              <span className="pill">
                {mobilityPassengers} {mobilityMode === 'walk' ? 'pedestrian' : 'pax'} ·{' '}
                {mobilityChannel} ({mobilityPcu.toFixed(1)} PCU)
              </span>
            </div>

            <div className="metrics-grid" style={{ marginTop: 8 }}>
              <div className="metric-box">
                <div className="metric-label">Live / Free Speed</div>
                <div className="metric-value" style={{ fontSize: 12.5 }}>
                  {mobilitySpeedKmh !== null ? `${mobilitySpeedKmh.toFixed(1)}` : '—'}
                  {mobilityFreeSpeedKmh !== null && (
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 500 }}>
                      {' '}
                      / {mobilityFreeSpeedKmh.toFixed(1)} km/h
                    </span>
                  )}
                </div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Road Status</div>
                <div
                  className="metric-value"
                  style={{
                    fontSize: 12.5,
                    color:
                      mobilityMode === 'walk'
                        ? 'var(--info)'
                        : mobilityLinkVc >= 0.85
                          ? 'var(--danger)'
                          : mobilityLinkVc >= 0.55
                            ? 'var(--warning)'
                            : 'var(--success)',
                  }}
                >
                  {mobilityMode === 'walk'
                    ? 'Sidewalk (0 PCU)'
                    : mobilityLinkVc >= 0.85
                      ? `Jam (V/C ${mobilityLinkVc.toFixed(2)})`
                      : mobilityLinkVc >= 0.55
                        ? `Busy (V/C ${mobilityLinkVc.toFixed(2)})`
                        : `Clear (${mobilityLinkVc.toFixed(2)})`}
                </div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Route</div>
                <div className="metric-value" style={{ fontSize: 12.5 }}>
                  {mobilityDistanceKm !== null ? `${mobilityDistanceKm.toFixed(2)} km` : '—'}
                </div>
              </div>
              <div className="metric-box">
                <div className="metric-label">ETA / Total</div>
                <div className="metric-value" style={{ fontSize: 12.5 }}>
                  {mobilityEtaMin !== null ? `${mobilityEtaMin.toFixed(1)} min` : '—'}
                  {mobilityDurationMin !== null && (
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 500 }}>
                      {' '}
                      / {mobilityDurationMin.toFixed(1)}m
                    </span>
                  )}
                </div>
              </div>
            </div>

            {mobilityProgressPct !== null && (
              <div style={{ marginTop: 8 }}>
                <div className="control-row" style={{ marginBottom: 4 }}>
                  <span>Trip Progress</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    {mobilityProgressPct.toFixed(0)}%
                  </span>
                </div>
                <div
                  className="mobility-progress-track"
                  role="progressbar"
                  aria-valuenow={Math.round(mobilityProgressPct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="mobility-progress-fill"
                    style={{
                      width: `${mobilityProgressPct}%`,
                      backgroundColor: mobilityModeColor,
                    }}
                  />
                </div>
              </div>
            )}

            {mobilityArrived && (
              <div
                className="pill"
                style={{
                  marginTop: 8,
                  color: 'var(--success)',
                  borderColor: 'var(--success)',
                  whiteSpace: 'normal',
                  height: 'auto',
                  lineHeight: 1.35,
                  borderRadius: 8,
                  padding: '4px 8px',
                }}
              >
                Arrived at {mobilityDest}. Trip complete; this dot now starts a new trip.
              </div>
            )}

            {!mobilityArrived && (
              <button
                type="button"
                className={`btn ${followAgent ? 'btn-primary active' : ''}`}
                style={{ marginTop: 8, width: '100%' }}
                onClick={() => setFollowAgent(!followAgent)}
                aria-pressed={followAgent}
              >
                <Crosshair size={13} aria-hidden="true" />
                {followAgent ? 'Following (drag map to stop)' : 'Follow this traveller'}
              </button>
            )}

            <div className="metrics-grid" style={{ marginTop: 8 }}>
              <div className="metric-box">
                <div className="metric-label">Departed / Elapsed</div>
                <div className="metric-value" style={{ fontSize: 12.5 }}>
                  {formatClock(mobilityDepartHours)}
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 500 }}>
                    {' '}
                    · {mobilityElapsedMin !== null ? `${mobilityElapsedMin.toFixed(1)} min` : '—'}
                  </span>
                </div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Delay vs Free-flow</div>
                <div
                  className="metric-value"
                  style={{
                    fontSize: 12.5,
                    color:
                      mobilityDelayMin !== null && mobilityDelayMin >= 3
                        ? 'var(--danger)'
                        : 'var(--text-primary)',
                  }}
                >
                  {mobilityDelayMin !== null ? `+${mobilityDelayMin.toFixed(1)} min` : '—'}
                </div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Travelled / Left</div>
                <div className="metric-value" style={{ fontSize: 12.5 }}>
                  {mobilityTravelledKm !== null ? `${mobilityTravelledKm.toFixed(2)} km` : '—'}
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 500 }}>
                    {' '}
                    / {mobilityRemainingKm !== null ? `${mobilityRemainingKm.toFixed(2)} km` : '—'}
                  </span>
                </div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Road Link</div>
                <div className="metric-value" style={{ fontSize: 12.5 }}>
                  {mobilityLinkIndex !== null && mobilityLinkCount !== null
                    ? `${mobilityLinkIndex} of ${mobilityLinkCount}`
                    : '—'}
                </div>
              </div>
            </div>

            <div
              className="metric-box"
              style={{ marginTop: 8 }}
              title="Each simulated dot is a sample of real traffic. The scale is the ratio of the assumed concurrent city travellers to simulated travellers."
            >
              <div className="metric-label">
                <Users size={11} aria-hidden="true" /> Represents
              </div>
              <div className="metric-value" style={{ fontSize: 12.5 }}>
                ≈ {mobilityRepresented !== null ? Math.round(mobilityRepresented).toLocaleString() : '—'}{' '}
                real {mobilityMode === 'walk' ? 'pedestrians' : 'travellers'}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                {mobilityPassengers} on board
                {mobilityMode === 'walk' ? '' : ` × ${mobilitySampleScale !== null ? mobilitySampleScale.toFixed(2) : '—'} vehicles per dot`}
                {' '}· one trip, {mobilityPurposeLabel}
              </div>
            </div>
          </section>
        )}

        {!isMobility &&
          (effectiveHeight !== null ||
          numFloors !== null ||
          areaM2 !== null ||
          groundElevation !== null ||
          coordsLabel !== null ||
          bclassLabel !== null ||
          poiCount !== null) && (
          <div className="metrics-grid">
            {bclassLabel !== null && (
              <div className="metric-box">
                <div className="metric-label">Class</div>
                <div className="metric-value" style={{ fontSize: 13 }}>
                  {formatClassLabel(bclassLabel)}
                </div>
              </div>
            )}
            {zonal !== null && (
              <div
                className="metric-box"
                title={`${zonal.tierLabel}${zonal.street ? ` (${zonal.street})` : ''}. BIR tax floor estimate, not a market price.`}
              >
                <div className="metric-label">Zonal value (est.)</div>
                <div className="metric-value" style={{ fontSize: 13 }}>
                  ₱{zonal.value.toLocaleString('en-PH')}/m²
                </div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  {zonal.street ?? zonal.tierLabel}
                </div>
              </div>
            )}
            {hazard !== null && (
              <div
                className="metric-box"
                title="Modelled storm surge from Project NOAH (ODbL) and elevation from a 30 m DEM. A screening result, not a forecast. NOAH flood maps do not cover Bacolod City."
              >
                <div className="metric-label">Storm surge / elevation</div>
                <div
                  className="metric-value"
                  style={{ fontSize: 13, color: hazard.surgeLevel > 0 ? 'var(--warning)' : 'inherit' }}
                >
                  {hazard.surgeLevel === 0 ? 'Not reached' : hazard.surgeLabel.replace('Reached by ', 'Reached by ')}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  {hazard.lowLying ? `Below ${hazard.lowLyingM} m elevation` : `At or above ${hazard.lowLyingM} m`}
                </div>
              </div>
            )}
            {tripStat !== null && (
              <div
                className="metric-box"
                title="Simulated trips that started (out) or ended (in) in this building since the simulation started. Open Reports > Trip generation for campus and land-use totals."
              >
                <div className="metric-label">Sim trips out / in</div>
                <div className="metric-value" style={{ fontSize: 13 }}>
                  {tripStat.out.toLocaleString()} / {tripStat.in.toLocaleString()}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  over {tripStat.hours.toFixed(1)} sim h
                </div>
              </div>
            )}
            {valueEst !== null && zonal && (
              <div
                className="metric-box"
                style={{ gridColumn: '1 / -1' }}
                title={`${zonal.valuation?.note ?? ''} ${zonal.valuation?.costSource ?? ''}`}
              >
                <div
                  className="metric-label"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <span>Est. property value (land + structure)</span>
                  <button
                    type="button"
                    aria-label="Show computation details"
                    aria-expanded={valueInfoOpen}
                    onClick={() => setValueInfoOpen((o) => !o)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      color: valueInfoOpen ? 'var(--accent, #38bdf8)' : 'inherit',
                      display: 'inline-flex',
                    }}
                  >
                    <Info size={13} />
                  </button>
                </div>
                <div className="metric-value" style={{ fontSize: 13 }}>
                  {formatPhp(valueEst.total)}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  Rough estimate: lot size and build cost are assumed.
                </div>
                {valueInfoOpen && zonal.valuation && (
                  <div style={{ fontSize: 10.5, lineHeight: 1.5, marginTop: 8, opacity: 0.9 }}>
                    {(() => {
                      const g = landUseGroup(bclassLabel);
                      const v = zonal.valuation;
                      const fp = areaM2 ?? 0;
                      return (
                        <>
                          <div><b>Land use group:</b> {g}</div>
                          <div>
                            <b>Zonal value:</b> {formatPhpFull(zonal.value)}/m² ·{' '}
                            {zonal.tierLabel}
                            {zonal.street ? ` (${zonal.street})` : ''}
                          </div>
                          <div>
                            <b>Lot area:</b> {Math.round(fp).toLocaleString('en-PH')} m² footprint ÷{' '}
                            {v.coverage[g]} coverage = {Math.round(valueEst.lotAreaM2).toLocaleString('en-PH')} m²
                          </div>
                          <div>
                            <b>Land:</b> {Math.round(valueEst.lotAreaM2).toLocaleString('en-PH')} m² ×{' '}
                            {formatPhpFull(zonal.value)} = {formatPhpFull(valueEst.landValue)}
                          </div>
                          <div>
                            <b>Structure:</b> {Math.round(fp).toLocaleString('en-PH')} m² × {valueEst.floors} floors ×{' '}
                            {formatPhpFull(v.costPerM2[g])}/m² = {formatPhpFull(valueEst.structureValue)}
                          </div>
                          <div>
                            <b>Total:</b> {formatPhpFull(valueEst.total)}
                          </div>
                          <div style={{ marginTop: 6, opacity: 0.75 }}>
                            Floors use the building's recorded count, else height ÷ 3.2 m. {v.note}{' '}
                            {v.costSource} Zonal values are BIR tax floors (DO 058-2023), not market prices.
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
            {valueEst !== null && zonal && (
              <div
                className="metric-box"
                title="Land value = lot area (footprint ÷ assumed coverage) × BIR zonal value."
              >
                <div className="metric-label">Land value (est.)</div>
                <div className="metric-value" style={{ fontSize: 13 }}>
                  {formatPhp(valueEst.landValue)}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  {Math.round(valueEst.lotAreaM2).toLocaleString('en-PH')} m² lot × ₱
                  {zonal.value.toLocaleString('en-PH')}/m²
                </div>
              </div>
            )}
            {valueEst !== null && zonal && (
              <div
                className="metric-box"
                title="Structure value = footprint × floors × assumed construction cost per m²."
              >
                <div className="metric-label">Structure value (est.)</div>
                <div className="metric-value" style={{ fontSize: 13 }}>
                  {formatPhp(valueEst.structureValue)}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>
                  {Math.round(areaM2 ?? 0).toLocaleString('en-PH')} m² × {valueEst.floors} fl
                  {zonal.valuation
                    ? ` × ₱${zonal.valuation.costPerM2[landUseGroup(bclassLabel)].toLocaleString('en-PH')}/m²`
                    : ''}
                </div>
              </div>
            )}
            {poiCount !== null && (
              <div className="metric-box">
                <div className="metric-label">Linked Places</div>
                <div className="metric-value">{poiCount}</div>
              </div>
            )}
            {effectiveHeight !== null && (
              <div className="metric-box">
                <div className="metric-label">Height</div>
                <div className="metric-value">{effectiveHeight.toFixed(1)} m</div>
              </div>
            )}
            {groundElevation !== null && (
              <div className="metric-box">
                <div className="metric-label">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Mountain size={10} /> Ground Elev.
                  </span>
                </div>
                <div className="metric-value">
                  {formatElevation(groundElevation)}
                </div>
                {effectiveHeight !== null && (
                  <div
                    style={{
                      fontSize: 10.5,
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      marginTop: 2,
                    }}
                  >
                    Roof ≈ {(groundElevation + effectiveHeight).toFixed(1)} m ASL
                  </div>
                )}
              </div>
            )}
            {numFloors !== null && (
              <div className="metric-box">
                <div className="metric-label">Floors</div>
                <div className="metric-value">{numFloors}</div>
              </div>
            )}
            {areaM2 !== null && (
              <div className="metric-box">
                <div className="metric-label">Footprint</div>
                <div className="metric-value">{formatArea(areaM2)}</div>
              </div>
            )}
            {coordsLabel !== null && inspectCoords !== null && (
              <div className="metric-box">
                <div className="metric-label">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <MapPin size={10} /> Lat, Lon
                  </span>
                </div>
                <div className="metric-value" style={{ fontSize: 11.5 }}>
                  {coordsLabel}
                </div>
                <div style={{ marginTop: 3 }}>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${inspectCoords[1].toFixed(6)},${inspectCoords[0].toFixed(6)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="poi-link"
                    title="Open this coordinate in Google Maps"
                  >
                    Open in Google Maps <ExternalLink size={10} />
                  </a>
                </div>
              </div>
            )}
          </div>
        )}

        {attachedPois.length > 0 && (
          <section className="poi-section" aria-label="Places inside or linked to building">
            <h3 className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Store size={11} />
              Places Inside / Linked ({attachedPois.length})
            </h3>
            <div className="poi-list">
              {visiblePois.map((poi) => (
                <PoiCard
                  key={poi.osm_id}
                  poi={poi}
                  highlighted={selectedFeature.highlightedPoiId === poi.osm_id}
                  buildingCenter={inspectCoords}
                />
              ))}
            </div>
            {attachedPois.length > 4 && (
              <button
                type="button"
                className="btn"
                style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
                onClick={() => setPoisExpanded((prev) => !prev)}
              >
                {poisExpanded
                  ? 'Show fewer'
                  : `Show all ${attachedPois.length} places`}
              </button>
            )}
          </section>
        )}

        {!isMobility && gersId && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '7px 9px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="metric-label">Overture / Feature ID</div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={gersId}
              >
                {gersId}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void handleCopyId()}
              aria-label="Copy feature ID"
            >
              {copiedId ? <Check size={13} /> : <Copy size={13} />}
              {copiedId ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}

        <div>
          <h3 className="section-label">Attributes ({entries.length})</h3>
          {entries.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              No properties reported for this feature.
            </p>
          ) : (
            <table className="kv-table">
              <tbody>
                {entries.map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">{key}</th>
                    <td>{formatPropValue(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </aside>
  );
}
