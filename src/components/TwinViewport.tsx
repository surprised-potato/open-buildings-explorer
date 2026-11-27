import {
  PathLayer,
  PolygonLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';
import { MapLibreOverlay } from '@deck.gl/maplibre';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { Mountain } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { BOUNDARIES_FILL_ID } from '../layers/builtins/boundariesLayer';
import {
  BUILDINGS_LABELS_LAYER_ID,
  BUILDINGS_LAYER_ID,
  BUILDINGS_SOURCE_ID,
} from '../layers/builtins/buildingsLayer';
import { createGeoJsonLayerDef } from '../layers/customVectorLoader';
import { useTwinStore } from '../layers/registry';
import type {
  BasemapTheme,
  LayerStateEntry,
  SelectedFeature,
  TwinLayerDefinition,
} from '../layers/types';
import { formatElevation } from '../utils/demSampler';
import {
  computePathLengthMeters,
  computePolygonAreaSqMeters,
  formatArea,
  formatDistance,
} from '../utils/geometry';
import {
  buildGoogleSatelliteTileUrl,
  createGoogleSatelliteSession,
} from '../utils/googleTiles';
import { loadMobilityDataset } from '../utils/mobilityLoader';
import { MobilitySimulation, setActiveSimulation } from '../utils/mobilitySim';
import type {
  CongestedEdgeSegment,
  MobilityDataset,
  MobilitySimParams,
  SelectedAgentInfo,
} from '../utils/mobilityTypes';
import { decodeUrlState, encodeUrlState } from '../utils/urlState';
import type { MeasureMode } from './MeasureControl';
import { PLACE_SLUG, getPlaceMeta } from '../utils/place';


const ESRI_SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  projection: { type: 'mercator' },
  sources: {
    'esri-world-imagery': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [
    {
      id: 'esri-world-imagery-layer',
      type: 'raster',
      source: 'esri-world-imagery',
    },
  ],
};

function buildGoogleSatelliteStyle(
  session: string,
  apiKey: string
): StyleSpecification {
  return {
    version: 8,
    projection: { type: 'mercator' },
    sources: {
      'google-satellite': {
        type: 'raster',
        tiles: [buildGoogleSatelliteTileUrl(session, apiKey)],
        tileSize: 256,
        maxzoom: 20,
        attribution: 'Imagery © Google',
      },
    },
    layers: [
      {
        id: 'google-satellite-layer',
        type: 'raster',
        source: 'google-satellite',
      },
    ],
  };
}

let pmtilesProtocolRegistered = false;

function ensurePmtilesProtocol(): void {
  if (pmtilesProtocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  pmtilesProtocolRegistered = true;
}

function getBasemapStyle(theme: BasemapTheme): string | StyleSpecification {
  if (theme === 'light') {
    return 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  }
  if (theme === 'satellite') {
    return ESRI_SATELLITE_STYLE;
  }
  return 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
}

function computeSunLightAndSky(sunHour: number, theme: BasemapTheme) {
  const clamped = Math.max(6, Math.min(19, sunHour));
  const t = (clamped - 6) / 13; // 0 at 06:00, 1 at 19:00
  const azimuth = 85 + t * 190; // East -> South -> West
  const noonDist = Math.abs(clamped - 12.5) / 6.5;
  const polar = 22 + noonDist * 56; // 22 deg near solar noon, 78 deg low sun
  const isGolden = clamped < 8 || clamped > 16.5;

  const lightColor = isGolden
    ? '#ffd9a8'
    : theme === 'light'
      ? '#fffcf5'
      : '#f8fafc';
  const intensity = isGolden ? 0.52 : 0.42;

  const skyColor =
    theme === 'light'
      ? isGolden
        ? '#f59e0b'
        : '#38bdf8'
      : isGolden
        ? '#1e1b4b'
        : '#0f172a';
  const horizonColor =
    theme === 'light'
      ? isGolden
        ? '#fde68a'
        : '#e0f2fe'
      : isGolden
        ? '#7c2d12'
        : '#1e293b';

  return {
    light: {
      anchor: 'viewport' as const,
      color: lightColor,
      intensity,
      position: [1.35, azimuth, polar] as [number, number, number],
    },
    sky: {
      'sky-color': skyColor,
      'horizon-color': horizonColor,
      'sky-horizon-blend': 0.5,
      'atmosphere-blend': theme === 'light' ? 0.7 : 0.45,
    },
  };
}

function computePolygonCentroid(points: [number, number][]): [number, number] {
  if (points.length === 0) return [0, 0];
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of points) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / points.length, sumLat / points.length];
}

function buildMeasureDeckLayers(
  mode: MeasureMode,
  points: [number, number][],
  getGroundZ: (lon: number, lat: number) => number
) {
  if (mode === 'off' || points.length === 0) return [];

  const result = [];
  const liftPath = points.map(
    ([lon, lat]): [number, number, number] => [lon, lat, getGroundZ(lon, lat) + 2]
  );

  if (mode === 'distance' && points.length >= 2) {
    result.push(
      new PathLayer({
        id: 'measure-path',
        data: [{ path: liftPath }],
        getPath: (d: { path: [number, number, number][] }) => d.path,
        getColor: [56, 189, 248, 240],
        getWidth: 4,
        widthUnits: 'pixels',
        pickable: false,
      })
    );

    const last = points[points.length - 1];
    result.push(
      new TextLayer({
        id: 'measure-distance-label',
        data: [
          {
            position: [last[0], last[1], getGroundZ(last[0], last[1]) + 14],
            text: formatDistance(computePathLengthMeters(points)),
          },
        ],
        getPosition: (d: { position: [number, number, number] }) => d.position,
        getText: (d: { text: string }) => d.text,
        getSize: 13,
        sizeUnits: 'pixels',
        getPixelOffset: [0, -18],
        getColor: [248, 250, 252, 255],
        background: true,
        getBackgroundColor: [15, 23, 42, 220],
        backgroundPadding: [6, 3],
        characterSet: 'auto',
        fontFamily: 'JetBrains Mono, monospace',
        fontWeight: 700,
      })
    );
  }

  if (mode === 'area') {
    if (points.length === 2) {
      result.push(
        new PathLayer({
          id: 'measure-area-edge',
          data: [{ path: liftPath }],
          getPath: (d: { path: [number, number, number][] }) => d.path,
          getColor: [251, 191, 36, 235],
          getWidth: 3,
          widthUnits: 'pixels',
        })
      );
    } else if (points.length >= 3) {
      result.push(
        new PolygonLayer({
          id: 'measure-area-poly',
          data: [{ contour: liftPath }],
          getPolygon: (d: { contour: [number, number, number][] }) => d.contour,
          filled: true,
          stroked: true,
          getFillColor: [251, 191, 36, 72],
          getLineColor: [251, 191, 36, 240],
          getLineWidth: 3,
          lineWidthUnits: 'pixels',
        })
      );

      const center = computePolygonCentroid(points);
      result.push(
        new TextLayer({
          id: 'measure-area-label',
          data: [
            {
              position: [
                center[0],
                center[1],
                getGroundZ(center[0], center[1]) + 14,
              ],
              text: formatArea(computePolygonAreaSqMeters(points)),
            },
          ],
          getPosition: (d: { position: [number, number, number] }) => d.position,
          getText: (d: { text: string }) => d.text,
          getSize: 13,
          sizeUnits: 'pixels',
          getColor: [254, 243, 199, 255],
          background: true,
          getBackgroundColor: [15, 23, 42, 220],
          backgroundPadding: [6, 3],
          characterSet: 'auto',
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 700,
        })
      );
    }
  }

  result.push(
    new ScatterplotLayer({
      id: 'measure-vertices',
      data: points.map((p, idx) => ({
        position: [p[0], p[1], getGroundZ(p[0], p[1]) + 4],
        idx,
      })),
      getPosition: (d: { position: [number, number, number] }) => d.position,
      getRadius: 6,
      radiusUnits: 'pixels',
      stroked: true,
      getFillColor: [255, 255, 255, 255],
      getLineColor: mode === 'area' ? [251, 191, 36, 255] : [56, 189, 248, 255],
      lineWidthMinPixels: 2,
    })
  );

  return result;
}

interface TwinViewportProps {
  measureMode: MeasureMode;
  measurePoints: [number, number][];
  onAddMeasurePoint: (coord: [number, number]) => void;
  sitePickMode?: boolean;
  siteCenter?: [number, number] | null;
  siteRadiusM?: number;
  onPickSite?: (coord: [number, number]) => void;
  profileHoverCoord?: [number, number] | null;
  onMapReady: (map: maplibregl.Map | null) => void;
  onNotify: (message: string) => void;
}

function buildAgentFeatureProps(info: SelectedAgentInfo, arrived: boolean) {
  return {
    origin_barangay: info.originZone,
    dest_barangay: info.destZone,
    purpose: info.purpose,
    purpose_label: info.purposeLabel,
    mode: info.mode,
    mode_label: info.modeLabel,
    passengers: info.passengers,
    pcu: info.pcu,
    channel: info.channel,
    free_flow_speed_kmh: info.freeFlowSpeedKmh,
    speed_kmh: arrived ? 0 : info.speedKmh,
    current_link_vc: info.currentLinkVc,
    distance_km: info.distanceKm,
    duration_min: info.durationMin,
    progress_pct: arrived ? 100 : info.progressPct,
    eta_min: arrived ? 0 : info.etaMin,
    arrived,
    trip_serial: info.tripSerial,
    sample_scale: info.sampleScale,
    represented_travellers: info.representedTravellers,
    depart_hours: info.departHours,
    elapsed_min: info.elapsedMin,
    delay_min: info.delayMin,
    travelled_km: arrived ? info.distanceKm : info.distanceTravelledKm,
    remaining_km: arrived ? 0 : info.distanceRemainingKm,
    link_index: info.linkIndex,
    link_count: info.linkCount,
    origin_bldg_class: info.originBuilding?.bclass,
    origin_bldg_name: info.originBuilding?.name ?? undefined,
    origin_bldg_area_m2: info.originBuilding?.areaM2,
    origin_bldg_role: info.originBuilding?.role,
    origin_bldg_access_m: info.originBuilding?.accessM,
    origin_bldg_id: info.originBuilding?.id ?? undefined,
    origin_bldg_lon: info.originBuilding?.lon,
    origin_bldg_lat: info.originBuilding?.lat,
    dest_bldg_class: info.destBuilding?.bclass,
    dest_bldg_name: info.destBuilding?.name ?? undefined,
    dest_bldg_area_m2: info.destBuilding?.areaM2,
    dest_bldg_role: info.destBuilding?.role,
    dest_bldg_access_m: info.destBuilding?.accessM,
    dest_bldg_id: info.destBuilding?.id ?? undefined,
    dest_bldg_lon: info.destBuilding?.lon,
    dest_bldg_lat: info.destBuilding?.lat,
  };
}

export function TwinViewport({
  measureMode,
  measurePoints,
  onAddMeasurePoint,
  sitePickMode = false,
  siteCenter = null,
  siteRadiusM = 500,
  onPickSite,
  profileHoverCoord = null,
  onMapReady,
  onNotify,
}: TwinViewportProps) {
  const {
    layers,
    layerState,
    theme,
    buildingColorMode,
    buildingConfidenceFilter,
    barangayChoropleth,
    selectedBarangayName,
    setSelectedBarangayName,
    poiCategoryFilter,
    buildingPois,
    terrainEnabled,
    terrainExaggeration,
    sunHour,
    selectedFeature,
    setSelectedFeature,
    demManifest,
    sampleElevation,
    googleMapsApiKey,
    initialUrlState,
    registerLayer,
    mobilityPlaying,
    mobilityTimeHours,
    setMobilityTimeHours,
    mobilitySpeed,
    mobilityAgentCount,
    mobilityBetaScale,
    mobilityEnabledModes,
    mobilityBarangayFilter,
    mobilityCongestionEnabled,
    mobilityCongestionLoad,
    mobilityGravityLambda,
    mobilityAttrBlend,
    mobilityColorMode,
    mobilityShowCongestedRoads,
    setMobilityStats,
    selectedAgentRoute,
    setSelectedAgentRoute,
    followAgent,
    setFollowAgent,
  } = useTwinStore();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const selectedAgentRef = useRef<{
    index: number;
    serial: number;
    origin: [number, number];
    dest: [number, number];
  } | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const styleReadyRef = useRef(false);
  const prevStyleKeyRef = useRef<string>(`${theme}:default`);
  const hoveredBuildingIdRef = useRef<string | number | null>(null);
  const prevSelectedBuildingIdRef = useRef<string | number | null>(null);
  const prevCatMatchIdsRef = useRef<string[]>([]);
  const cursorRafRef = useRef<number | null>(null);
  const cursorPendingRef = useRef<[number, number] | null>(null);
  const pickableLayerMetaRef = useRef<
    Array<{ mapLayerId: string; def: TwinLayerDefinition }>
  >([]);

  const mobilityDatasetRef = useRef<MobilityDataset | null>(null);
  const mobilitySimRef = useRef<MobilitySimulation | null>(null);
  const mobilityLoadingRef = useRef(false);
  const mobilityFailedRef = useRef(false);
  const mobilityFrameTickRef = useRef(0);
  const mobilitySimTimeRef = useRef(mobilityTimeHours);
  const mobilityLastSyncedTimeRef = useRef(mobilityTimeHours);
  const mobilityLastUiSyncMsRef = useRef(0);
  const mobilityLastRibbonMsRef = useRef(0);
  const mobilityCongestedRoadsRef = useRef<CongestedEdgeSegment[]>([]);
  const [mobilityLoadedTick, setMobilityLoadedTick] = useState(0);

  const [dragOver, setDragOver] = useState(false);
  const [cursorTelemetry, setCursorTelemetry] = useState<{
    lon: number;
    lat: number;
    elev: number | null;
  } | null>(null);

  // Latest state refs for imperative MapLibre event handlers
  const latestRef = useRef({
    layers,
    layerState,
    theme,
    buildingColorMode,
    buildingConfidenceFilter,
    barangayChoropleth,
    selectedBarangayName,
    setSelectedBarangayName,
    poiCategoryFilter,
    buildingPois,
    terrainEnabled,
    terrainExaggeration,
    sunHour,
    selectedFeature,
    demManifest,
    sampleElevation,
    measureMode,
    measurePoints,
    sitePickMode,
    siteCenter,
    siteRadiusM,
    profileHoverCoord,
    mobilityPlaying,
    mobilityTimeHours,
    mobilitySpeed,
    mobilityAgentCount,
    mobilityBetaScale,
    mobilityEnabledModes,
    mobilityBarangayFilter,
    mobilityCongestionEnabled,
    mobilityCongestionLoad,
    mobilityGravityLambda,
    mobilityAttrBlend,
    mobilityColorMode,
    mobilityShowCongestedRoads,
    selectedAgentRoute,
    followAgent,
  });
  latestRef.current = {
    layers,
    layerState,
    theme,
    buildingColorMode,
    buildingConfidenceFilter,
    barangayChoropleth,
    selectedBarangayName,
    setSelectedBarangayName,
    poiCategoryFilter,
    buildingPois,
    terrainEnabled,
    terrainExaggeration,
    sunHour,
    selectedFeature,
    demManifest,
    sampleElevation,
    measureMode,
    measurePoints,
    sitePickMode,
    siteCenter,
    siteRadiusM,
    profileHoverCoord,
    mobilityPlaying,
    mobilityTimeHours,
    mobilitySpeed,
    mobilityAgentCount,
    mobilityBetaScale,
    mobilityEnabledModes,
    mobilityBarangayFilter,
    mobilityCongestionEnabled,
    mobilityCongestionLoad,
    mobilityGravityLambda,
    mobilityAttrBlend,
    mobilityColorMode,
    mobilityShowCongestedRoads,
    selectedAgentRoute,
    followAgent,
  };

  const tripBuildingIdsRef = useRef<{ origin: string | null; dest: string | null }>({
    origin: null,
    dest: null,
  });

  /** Colour the followed traveller's origin (green) and destination (red) buildings. */
  const setTripBuildingHighlights = useCallback(
    (origin: string | null, dest: string | null) => {
      const map = mapRef.current;
      const prev = tripBuildingIdsRef.current;
      tripBuildingIdsRef.current = { origin, dest };
      if (!map || !map.getSource(BUILDINGS_SOURCE_ID)) return;
      const apply = (id: string | null, key: 'tripOrigin' | 'tripDest', on: boolean) => {
        if (!id) return;
        try {
          map.setFeatureState(
            { source: BUILDINGS_SOURCE_ID, sourceLayer: 'buildings', id },
            { [key]: on }
          );
        } catch {
          // Tile not loaded yet; ignore
        }
      };
      apply(prev.origin, 'tripOrigin', false);
      apply(prev.dest, 'tripDest', false);
      apply(origin, 'tripOrigin', true);
      apply(dest, 'tripDest', true);
    },
    []
  );

  const syncBuildingFeatureStates = useCallback((map: maplibregl.Map) => {
    if (!map.getSource(BUILDINGS_SOURCE_ID)) return;

    const currentSelectedId =
      latestRef.current.selectedFeature?.layerId === 'buildings'
        ? latestRef.current.selectedFeature.id ?? null
        : null;

    if (
      prevSelectedBuildingIdRef.current !== null &&
      prevSelectedBuildingIdRef.current !== currentSelectedId
    ) {
      try {
        map.setFeatureState(
          {
            source: BUILDINGS_SOURCE_ID,
            sourceLayer: 'buildings',
            id: prevSelectedBuildingIdRef.current,
          },
          { selected: false }
        );
      } catch {
        // Ignore if tile not yet loaded
      }
    }

    if (currentSelectedId !== null) {
      try {
        map.setFeatureState(
          {
            source: BUILDINGS_SOURCE_ID,
            sourceLayer: 'buildings',
            id: currentSelectedId,
          },
          { selected: true }
        );
      } catch {
        // Ignore if tile not yet loaded
      }
    }
    prevSelectedBuildingIdRef.current = currentSelectedId;

    if (hoveredBuildingIdRef.current !== null) {
      try {
        map.setFeatureState(
          {
            source: BUILDINGS_SOURCE_ID,
            sourceLayer: 'buildings',
            id: hoveredBuildingIdRef.current,
          },
          { hover: true }
        );
      } catch {
        // Ignore if tile not yet loaded
      }
    }

    for (const prevId of prevCatMatchIdsRef.current) {
      try {
        map.setFeatureState(
          {
            source: BUILDINGS_SOURCE_ID,
            sourceLayer: 'buildings',
            id: prevId,
          },
          { catMatch: false }
        );
      } catch {
        // Ignore if tile not loaded
      }
    }

    const activeCat = latestRef.current.poiCategoryFilter;
    const nextMatchedIds: string[] = [];
    if (activeCat && activeCat !== 'all') {
      for (const rec of Object.values(latestRef.current.buildingPois)) {
        if (rec.pois?.some((p) => p.category === activeCat)) {
          nextMatchedIds.push(rec.id);
          try {
            map.setFeatureState(
              {
                source: BUILDINGS_SOURCE_ID,
                sourceLayer: 'buildings',
                id: rec.id,
              },
              { catMatch: true }
            );
          } catch {
            // Ignore if tile not loaded
          }
        }
      }
    }
    prevCatMatchIdsRef.current = nextMatchedIds;
  }, []);

  const buildAllDeckLayers = useCallback(() => {
    const snap = latestRef.current;
    const deckLayers = snap.layers
      .filter((layer) => layer.engine === 'deck' && layer.buildDeckLayer)
      .flatMap((layer) => {
        const entry: LayerStateEntry = snap.layerState[layer.id] ?? {
          visible: layer.defaultVisible,
          opacity: layer.defaultOpacity,
          style: layer.defaultStyle,
        };
        const built = layer.buildDeckLayer?.({
          visible: entry.visible,
          opacity: entry.opacity,
          theme: snap.theme,
          buildingColorMode: snap.buildingColorMode,
          sunHour: snap.sunHour,
          terrainEnabled: snap.terrainEnabled,
          terrainExaggeration: snap.terrainExaggeration,
          sampleElevation: snap.sampleElevation,
          style: entry.style ?? layer.defaultStyle,
          selectedFeature: snap.selectedFeature,
          onSelectFeature: (feature) => {
            if (latestRef.current.measureMode === 'off') {
              setSelectedFeature(feature);
            }
          },
        });
        if (!built) return [];
        return Array.isArray(built) ? built : [built];
      });

    const getGroundZ = (lon: number, lat: number): number => {
      if (!snap.terrainEnabled) return 0;
      const e = snap.sampleElevation(lon, lat);
      return e !== null ? e * snap.terrainExaggeration : 0;
    };

    const overlayLayers = [];

    if (snap.siteCenter) {
      const [sLon, sLat] = snap.siteCenter;
      const sZ = getGroundZ(sLon, sLat) + 3;
      overlayLayers.push(
        new ScatterplotLayer({
          id: 'site-catchment-ring',
          data: [{ position: [sLon, sLat, sZ] }],
          getPosition: (d: { position: [number, number, number] }) => d.position,
          getRadius: snap.siteRadiusM,
          radiusUnits: 'meters',
          filled: true,
          stroked: true,
          getFillColor: [16, 185, 129, 40],
          getLineColor: [52, 211, 153, 235],
          lineWidthMinPixels: 2,
          pickable: false,
        }),
        new ScatterplotLayer({
          id: 'site-catchment-pin',
          data: [{ position: [sLon, sLat, sZ + 2] }],
          getPosition: (d: { position: [number, number, number] }) => d.position,
          getRadius: 7,
          radiusUnits: 'pixels',
          filled: true,
          stroked: true,
          getFillColor: [16, 185, 129, 255],
          getLineColor: [255, 255, 255, 255],
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    if (snap.profileHoverCoord) {
      const [hLon, hLat] = snap.profileHoverCoord;
      const hZ = getGroundZ(hLon, hLat) + 6;
      overlayLayers.push(
        new ScatterplotLayer({
          id: 'profile-hover-marker',
          data: [{ position: [hLon, hLat, hZ] }],
          getPosition: (d: { position: [number, number, number] }) => d.position,
          getRadius: 8,
          radiusUnits: 'pixels',
          filled: true,
          stroked: true,
          getFillColor: [253, 224, 71, 255],
          getLineColor: [15, 23, 42, 255],
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    const mobilityLayers = [];
    const mobilityEntry = snap.layerState.mobility;
    const mobilityVisible = Boolean(mobilityEntry?.visible);
    const mobilityOpacity = mobilityEntry?.opacity ?? 0.95;
    const sim = mobilitySimRef.current;

    if (mobilityVisible && sim) {
      if (
        snap.mobilityShowCongestedRoads &&
        snap.mobilityCongestionEnabled &&
        mobilityCongestedRoadsRef.current.length > 0
      ) {
        mobilityLayers.push(
          new PathLayer({
            id: 'mobility-congested-roads',
            data: mobilityCongestedRoadsRef.current,
            getPath: (d: CongestedEdgeSegment) => d.path,
            getColor: (d: CongestedEdgeSegment): [number, number, number, number] =>
              d.vc >= 1.15
                ? [239, 68, 68, 225]
                : d.vc >= 0.85
                  ? [249, 115, 22, 200]
                  : [245, 158, 11, 165],
            getWidth: (d: CongestedEdgeSegment) => 2 + Math.min(4, d.vc * 1.8),
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            pickable: false,
            opacity: mobilityOpacity,
          })
        );
      }

      const slice = sim.getRenderSlice();
      if (slice.count > 0) {
        const tick = mobilityFrameTickRef.current;
        mobilityLayers.push(
          new ScatterplotLayer({
            id: 'mobility-swarm-dots',
            data: {
              length: slice.count,
              attributes: {
                getPosition: { value: slice.positions, size: 3 },
                getFillColor: { value: slice.colors, size: 4, normalized: true },
                getRadius: { value: slice.radii, size: 1 },
              },
            },
            radiusUnits: 'pixels',
            radiusMinPixels: 1.5,
            radiusMaxPixels: 5.5,
            opacity: mobilityOpacity,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 220],
            updateTriggers: {
              getPosition: tick,
              getFillColor: tick,
              getRadius: tick,
            },
            onClick: (info) => {
              const cur = latestRef.current;
              if (cur.measureMode !== 'off' || cur.sitePickMode) return false;
              const activeSim = mobilitySimRef.current;
              if (
                !activeSim ||
                typeof info.index !== 'number' ||
                info.index < 0
              ) {
                return false;
              }
              const agentInfo = activeSim.getAgentInfo(
                info.index,
                cur.terrainEnabled,
                cur.terrainExaggeration,
                cur.mobilityCongestionEnabled
              );
              if (!agentInfo) return false;

              setSelectedAgentRoute(agentInfo.routePath);
              setTripBuildingHighlights(
                agentInfo.originBuilding?.id ?? null,
                agentInfo.destBuilding?.id ?? null
              );
              selectedAgentRef.current = {
                index: agentInfo.agentId,
                serial: agentInfo.tripSerial,
                origin: agentInfo.originCoords,
                dest: agentInfo.destCoords,
              };
              setSelectedFeature({
                layerId: 'mobility',
                layerName: 'Mobility Traveller',
                id: agentInfo.agentId,
                coordinates: agentInfo.coordinates,
                properties: buildAgentFeatureProps(agentInfo, false),
              });
              return true;
            },
          })
        );
      }
    }

    const selAgent = selectedAgentRef.current;
    if (mobilityVisible && selAgent && sim) {
      const pos = sim.getAgentPosition(selAgent.index, selAgent.serial);
      mobilityLayers.push(
        new ScatterplotLayer({
          id: 'selected-agent-endpoints',
          data: [
            { p: selAgent.origin, c: [74, 222, 128, 255] },
            { p: selAgent.dest, c: [248, 113, 113, 255] },
          ],
          getPosition: (d: { p: [number, number] }) => [d.p[0], d.p[1], getGroundZ(d.p[0], d.p[1]) + 4],
          getFillColor: (d: { c: number[] }) => d.c as [number, number, number, number],
          getLineColor: [255, 255, 255, 255],
          getRadius: 7,
          radiusUnits: 'pixels',
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          pickable: false,
        })
      );
      if (pos) {
        mobilityLayers.push(
          new ScatterplotLayer({
            id: 'selected-agent-ring',
            data: [{ p: pos }],
            getPosition: (d: { p: [number, number, number] }) => d.p,
            getRadius: 12,
            radiusUnits: 'pixels',
            stroked: true,
            filled: false,
            lineWidthUnits: 'pixels',
            getLineWidth: 3,
            getLineColor: [255, 255, 255, 255],
            pickable: false,
            updateTriggers: { getPosition: mobilityFrameTickRef.current },
          })
        );
      }
    }

    if (mobilityVisible && snap.selectedAgentRoute && snap.selectedAgentRoute.length >= 2) {
      mobilityLayers.push(
        new PathLayer({
          id: 'selected-agent-route-glow',
          data: [{ path: snap.selectedAgentRoute }],
          getPath: (d: { path: [number, number, number][] }) => d.path,
          getColor: [56, 189, 248, 95],
          getWidth: 9,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          pickable: false,
        }),
        new PathLayer({
          id: 'selected-agent-route',
          data: [{ path: snap.selectedAgentRoute }],
          getPath: (d: { path: [number, number, number][] }) => d.path,
          getColor: [251, 191, 36, 245],
          getWidth: 4,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          pickable: false,
        })
      );
    }

    return [
      ...deckLayers,
      ...mobilityLayers,
      ...overlayLayers,
      ...buildMeasureDeckLayers(snap.measureMode, snap.measurePoints, getGroundZ),
    ];
  }, [setSelectedAgentRoute, setSelectedFeature]);

  const applyMapLibreScene = useCallback(
    (map: maplibregl.Map) => {
      if (!styleReadyRef.current) return;
      const snap = latestRef.current;
      const nextPickable: Array<{ mapLayerId: string; def: TwinLayerDefinition }> =
        [];

      for (const layer of snap.layers) {
        if (layer.engine !== 'maplibre' || !layer.maplibre) continue;
        const entry = snap.layerState[layer.id] ?? {
          visible: layer.defaultVisible,
          opacity: layer.defaultOpacity,
          style: layer.defaultStyle,
        };
        const returnedIds = layer.maplibre({
          map,
          visible: entry.visible,
          opacity: entry.opacity,
          theme: snap.theme,
          buildingColorMode: snap.buildingColorMode,
          buildingConfidenceFilter: snap.buildingConfidenceFilter,
          barangayChoropleth: snap.barangayChoropleth,
          selectedBarangayName: snap.selectedBarangayName,
          poiCategoryFilter: snap.poiCategoryFilter,
          buildingPois: snap.buildingPois,
          terrainEnabled: snap.terrainEnabled,
          terrainExaggeration: snap.terrainExaggeration,
          demManifest: snap.demManifest,
          style: entry.style ?? layer.defaultStyle,
          selectedFeature: snap.selectedFeature,
          hoveredFeatureId: hoveredBuildingIdRef.current,
        });

        const ids = Array.isArray(returnedIds)
          ? returnedIds
          : layer.pickableLayerIds ?? [];
        for (const mapLayerId of ids) {
          nextPickable.push({ mapLayerId, def: layer });
        }
      }

      pickableLayerMetaRef.current = nextPickable;

      const { light, sky } = computeSunLightAndSky(snap.sunHour, snap.theme);
      try {
        map.setLight(light);
      } catch {
        // Ignore if style rejects light update during transition
      }
      try {
        map.setSky(sky as never);
      } catch {
        // Ignore if style does not support sky
      }

      syncBuildingFeatureStates(map);
    },
    [syncBuildingFeatureStates]
  );

  const syncUrlHash = useCallback((map: maplibregl.Map) => {
    const snap = latestRef.current;
    const center = map.getCenter();
    const hiddenLayers = snap.layers
      .filter((l) => {
        const st = snap.layerState[l.id];
        return st ? !st.visible : !l.defaultVisible;
      })
      .map((l) => l.id);

    const hash = encodeUrlState({
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      theme: snap.theme,
      colorMode: snap.buildingColorMode,
      terrainEnabled: snap.terrainEnabled,
      terrainExaggeration: snap.terrainExaggeration,
      sunHour: snap.sunHour,
      hiddenLayers,
      view: decodeUrlState(window.location.hash).view,
      place: PLACE_SLUG,
    });

    const nextUrl = hash || window.location.pathname + window.location.search;
    window.history.replaceState(null, '', nextUrl);
  }, []);

  // Initialize MapLibre + MapLibreOverlay once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensurePmtilesProtocol();

    const map = new maplibregl.Map({
      container,
      style: getBasemapStyle(latestRef.current.theme),
      center: initialUrlState.center ?? getPlaceMeta().homeView.center,
      zoom: initialUrlState.zoom ?? getPlaceMeta().homeView.zoom,
      pitch: initialUrlState.pitch ?? getPlaceMeta().homeView.pitch,
      bearing: initialUrlState.bearing ?? getPlaceMeta().homeView.bearing,
      maxPitch: 85,
      canvasContextAttributes: { antialias: true },
      attributionControl: {
        compact: true,
        customAttribution:
          'Data © OpenStreetMap contributors (ODbL), Overture Maps, Project NOAH (UP), PSA, WorldPop, ESA WorldCover (CC BY 4.0)',
      },
    });

    mapRef.current = map;
    if (window.matchMedia('(max-width: 720px)').matches) {
      // Start with the credits collapsed behind the (i) button on phones.
      const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
      attrib?.classList.remove('maplibregl-compact-show');
      attrib?.removeAttribute('open');
    }
    map.on('dragstart', () => setFollowAgent(false));
    onMapReady(map);

    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    const overlay = new MapLibreOverlay({
      interleaved: true,
      layers: buildAllDeckLayers(),
    });
    overlayRef.current = overlay;
    map.addControl(overlay);

    const handleStyleLoad = () => {
      styleReadyRef.current = true;
      applyMapLibreScene(map);
      overlay.setProps({ layers: buildAllDeckLayers() });
    };

    const handleMoveEnd = () => {
      syncUrlHash(map);
    };

    const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
      cursorPendingRef.current = [e.lngLat.lng, e.lngLat.lat];
      if (cursorRafRef.current === null) {
        cursorRafRef.current = window.requestAnimationFrame(() => {
          cursorRafRef.current = null;
          const pos = cursorPendingRef.current;
          if (!pos) return;
          const elev = latestRef.current.sampleElevation(pos[0], pos[1]);
          setCursorTelemetry({ lon: pos[0], lat: pos[1], elev });
        });
      }

      const canvas = map.getCanvas();
      if (latestRef.current.measureMode !== 'off' || latestRef.current.sitePickMode) {
        canvas.style.cursor = 'crosshair';
        return;
      }

      let hoveringDeck = false;
      try {
        const deckHit = overlay.pickObject({
          x: e.point.x,
          y: e.point.y,
          radius: 4,
        });
        hoveringDeck = Boolean(
          deckHit && (deckHit.object || (deckHit.layer && deckHit.index >= 0))
        );
      } catch {
        hoveringDeck = false;
      }

      const activeLayerIds = pickableLayerMetaRef.current
        .map((m) => m.mapLayerId)
        .filter((id) => Boolean(map.getLayer(id)));

      const features =
        !hoveringDeck && activeLayerIds.length > 0
          ? map.queryRenderedFeatures(e.point, { layers: activeLayerIds })
          : [];

      const hoveredBuilding = features.find(
        (f) =>
          f.layer?.id === BUILDINGS_LAYER_ID ||
          f.layer?.id === BUILDINGS_LABELS_LAYER_ID
      );
      const nextHoveredId =
        (hoveredBuilding?.properties?.id as string | number | undefined) ??
        hoveredBuilding?.id ??
        null;

      if (hoveredBuildingIdRef.current !== nextHoveredId) {
        if (
          hoveredBuildingIdRef.current !== null &&
          map.getSource(BUILDINGS_SOURCE_ID)
        ) {
          try {
            map.setFeatureState(
              {
                source: BUILDINGS_SOURCE_ID,
                sourceLayer: 'buildings',
                id: hoveredBuildingIdRef.current,
              },
              { hover: false }
            );
          } catch {
            // Ignore
          }
        }
        hoveredBuildingIdRef.current = nextHoveredId;
        if (nextHoveredId !== null && map.getSource(BUILDINGS_SOURCE_ID)) {
          try {
            map.setFeatureState(
              {
                source: BUILDINGS_SOURCE_ID,
                sourceLayer: 'buildings',
                id: nextHoveredId,
              },
              { hover: true }
            );
          } catch {
            // Ignore
          }
        }
      }

      const hasInteractiveHit =
        hoveringDeck ||
        features.some((f) => f.layer?.id !== 'boundaries-fill');
      canvas.style.cursor = hasInteractiveHit ? 'pointer' : '';
    };

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      if (latestRef.current.measureMode !== 'off') {
        onAddMeasurePoint([e.lngLat.lng, e.lngLat.lat]);
        return;
      }

      if (latestRef.current.sitePickMode && onPickSite) {
        onPickSite([e.lngLat.lng, e.lngLat.lat]);
        return;
      }

      try {
        const deckHit = overlay.pickObject({
          x: e.point.x,
          y: e.point.y,
          radius: 4,
        });
        if (deckHit && (deckHit.object || (deckHit.layer && deckHit.index >= 0))) {
          return;
        }
      } catch {
        // Ignore if deck is mid-transition
      }

      const activeLayerIds = pickableLayerMetaRef.current
        .map((m) => m.mapLayerId)
        .filter((id) => Boolean(map.getLayer(id)));

      if (activeLayerIds.length === 0) {
        setSelectedFeature(null);
        setSelectedBarangayName(null);
        return;
      }

      const features = map.queryRenderedFeatures(e.point, {
        layers: activeLayerIds,
      });

      if (features.length === 0) {
        setSelectedFeature(null);
        setSelectedBarangayName(null);
        return;
      }

      // Prefer buildings (or their z16+ POI labels) and custom layers over background barangay polygons
      const preferred =
        features.find((f) => f.layer?.id === BUILDINGS_LABELS_LAYER_ID) ??
        features.find((f) => f.layer?.id === BUILDINGS_LAYER_ID) ??
        features.find((f) => f.layer?.id !== BOUNDARIES_FILL_ID) ??
        features[0];

      const meta = pickableLayerMetaRef.current.find(
        (m) => m.mapLayerId === preferred.layer?.id
      );

      const props = (preferred.properties ?? {}) as Record<string, unknown>;
      const isBuildingOrLabel =
        preferred.layer?.id === BUILDINGS_LAYER_ID ||
        preferred.layer?.id === BUILDINGS_LABELS_LAYER_ID;
      const featureId =
        (typeof props.id === 'string' || typeof props.id === 'number'
          ? props.id
          : undefined) ?? preferred.id;

      if (
        preferred.layer?.id === BOUNDARIES_FILL_ID &&
        props.level === 'barangay' &&
        typeof props.name === 'string' &&
        props.name.trim()
      ) {
        setSelectedBarangayName(props.name.trim());
      }

      const nextFeature: SelectedFeature = {
        layerId: isBuildingOrLabel
          ? 'buildings'
          : meta?.def.id ?? preferred.layer?.id ?? 'unknown',
        layerName: isBuildingOrLabel
          ? '3D Buildings'
          : meta?.def.name ?? preferred.layer?.id ?? 'Layer',
        id: featureId,
        coordinates: [e.lngLat.lng, e.lngLat.lat],
        properties: props,
      };
      setSelectedFeature(nextFeature);
    };

    map.on('style.load', handleStyleLoad);
    map.on('moveend', handleMoveEnd);
    map.on('mousemove', handleMouseMove);
    map.on('click', handleClick);

    return () => {
      styleReadyRef.current = false;
      if (cursorRafRef.current !== null) {
        window.cancelAnimationFrame(cursorRafRef.current);
        cursorRafRef.current = null;
      }
      map.off('style.load', handleStyleLoad);
      map.off('moveend', handleMoveEnd);
      map.off('mousemove', handleMouseMove);
      map.off('click', handleClick);
      onMapReady(null);
      mapRef.current = null;
      overlayRef.current = null;
      map.remove();
    };
  }, [
    applyMapLibreScene,
    buildAllDeckLayers,
    initialUrlState.bearing,
    initialUrlState.center,
    initialUrlState.pitch,
    initialUrlState.zoom,
    onAddMeasurePoint,
    onMapReady,
    onPickSite,
    setSelectedBarangayName,
    setSelectedFeature,
    syncUrlHash,
  ]);

  // Switch basemap style cleanly when theme or Google Satellite API key changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const trimmedKey = googleMapsApiKey.trim();
    const styleKey =
      theme === 'satellite' && trimmedKey
        ? `satellite:google:${trimmedKey}`
        : `${theme}:default`;

    if (prevStyleKeyRef.current === styleKey) return;
    prevStyleKeyRef.current = styleKey;

    let cancelled = false;

    async function applyThemeStyle() {
      if (!map) return;
      const swapStyle = (nextStyle: string | StyleSpecification) => {
        styleReadyRef.current = false;
        try {
          if (map.getTerrain()) {
            map.setTerrain(null);
          }
        } catch {
          // Ignore if terrain already cleared
        }
        map.setStyle(nextStyle, { diff: false });
      };

      if (theme === 'satellite' && trimmedKey) {
        try {
          const sessionData = await createGoogleSatelliteSession(trimmedKey);
          if (cancelled) return;
          swapStyle(buildGoogleSatelliteStyle(sessionData.session, trimmedKey));
          return;
        } catch (err) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : 'Session error';
          onNotify(`Google Satellite unavailable (${msg}); using Esri imagery`);
        }
      }

      if (cancelled) return;
      swapStyle(getBasemapStyle(theme));
    }

    void applyThemeStyle();
    return () => {
      cancelled = true;
    };
  }, [theme, googleMapsApiKey, onNotify]);

  // Re-apply MapLibre layer visibility, styles, terrain, sun light, and selection
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (styleReadyRef.current) {
      applyMapLibreScene(map);
    }
    syncUrlHash(map);
  }, [
    layers,
    layerState,
    theme,
    buildingColorMode,
    buildingConfidenceFilter,
    barangayChoropleth,
    selectedBarangayName,
    setSelectedBarangayName,
    poiCategoryFilter,
    buildingPois,
    terrainEnabled,
    terrainExaggeration,
    demManifest,
    sunHour,
    selectedFeature,
    applyMapLibreScene,
    syncUrlHash,
  ]);

  // Sync interleaved deck.gl layers and live measure geometry
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.setProps({ layers: buildAllDeckLayers() });
  }, [
    layers,
    layerState,
    theme,
    buildingColorMode,
    buildingConfidenceFilter,
    terrainEnabled,
    terrainExaggeration,
    demManifest,
    sunHour,
    selectedFeature,
    selectedAgentRoute,
    measureMode,
    measurePoints,
    siteCenter,
    siteRadiusM,
    profileHoverCoord,
    mobilityLoadedTick,
    buildAllDeckLayers,
  ]);

  useEffect(() => {
    if (selectedFeature?.layerId !== 'mobility') {
      selectedAgentRef.current = null;
      setTripBuildingHighlights(null, null);
    }
  }, [selectedFeature, setTripBuildingHighlights]);

  const mobilityVisible = Boolean(layerState.mobility?.visible);
  const mobilityOpacity = layerState.mobility?.opacity ?? 0.95;

  // Lazily fetch Bacolod mobility network + zone demand when mobility layer is visible
  useEffect(() => {
    if (!mobilityVisible) return;
    if (mobilityDatasetRef.current || mobilityLoadingRef.current || mobilityFailedRef.current) {
      return;
    }

    mobilityLoadingRef.current = true;
    const controller = new AbortController();
    const base = import.meta.env?.BASE_URL ?? '/';

    loadMobilityDataset(base, controller.signal)
      .then((dataset) => {
        if (controller.signal.aborted) return;
        mobilityDatasetRef.current = dataset;
        const sim = new MobilitySimulation(dataset);
        mobilitySimRef.current = sim;
        setActiveSimulation(sim);
        if (import.meta.env.DEV) {
          (window as unknown as { __twinDebug?: unknown }).__twinDebug = {
            sim,
            getMap: () => mapRef.current,
          };
        }

        const snap = latestRef.current;
        const params: MobilitySimParams = {
          targetAgents: snap.mobilityAgentCount,
          betaScale: snap.mobilityBetaScale,
          enabledModes: snap.mobilityEnabledModes,
          selectedBarangayName: snap.selectedBarangayName,
          barangayFilter: snap.mobilityBarangayFilter,
          terrainEnabled: snap.terrainEnabled,
          terrainExaggeration: snap.terrainExaggeration,
          opacity: snap.layerState.mobility?.opacity ?? 0.95,
          congestionEnabled: snap.mobilityCongestionEnabled,
          congestionLoadScale: snap.mobilityCongestionLoad,
          gravityLambdaKm: snap.mobilityGravityLambda,
          attrBlend: snap.mobilityAttrBlend,
          colorMode: snap.mobilityColorMode,
        };
        const stats = sim.refreshVisuals(params, mobilitySimTimeRef.current);
        mobilityCongestedRoadsRef.current =
          snap.mobilityShowCongestedRoads && snap.mobilityCongestionEnabled
            ? sim.getCongestedEdges(snap.terrainEnabled, snap.terrainExaggeration)
            : [];
        mobilityFrameTickRef.current += 1;
        setMobilityStats(stats);
        setMobilityLoadedTick((t) => t + 1);
        overlayRef.current?.setProps({ layers: buildAllDeckLayers() });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        mobilityFailedRef.current = true;
        const msg = err instanceof Error ? err.message : 'Network unavailable';
        onNotify(`Mobility swarm data unavailable (${msg})`);
      })
      .finally(() => {
        mobilityLoadingRef.current = false;
      });

    return () => {
      controller.abort();
      mobilityLoadingRef.current = false;
    };
  }, [mobilityVisible, buildAllDeckLayers, onNotify, setMobilityStats]);

  // Sync external time scrub (from slider) into simulation clock and refresh visuals
  useEffect(() => {
    if (Math.abs(mobilityTimeHours - mobilityLastSyncedTimeRef.current) <= 1e-5) {
      return;
    }
    mobilitySimTimeRef.current = mobilityTimeHours;
    mobilityLastSyncedTimeRef.current = mobilityTimeHours;

    const sim = mobilitySimRef.current;
    if (!sim || !mobilityVisible) return;
    const snap = latestRef.current;
    const stats = sim.refreshVisuals(
      {
        targetAgents: snap.mobilityAgentCount,
        betaScale: snap.mobilityBetaScale,
        enabledModes: snap.mobilityEnabledModes,
        selectedBarangayName: snap.selectedBarangayName,
        barangayFilter: snap.mobilityBarangayFilter,
        terrainEnabled: snap.terrainEnabled,
        terrainExaggeration: snap.terrainExaggeration,
        opacity: mobilityOpacity,
        congestionEnabled: snap.mobilityCongestionEnabled,
        congestionLoadScale: snap.mobilityCongestionLoad,
        gravityLambdaKm: snap.mobilityGravityLambda,
        attrBlend: snap.mobilityAttrBlend,
        colorMode: snap.mobilityColorMode,
      },
      mobilityTimeHours
    );
    mobilityCongestedRoadsRef.current =
      snap.mobilityShowCongestedRoads && snap.mobilityCongestionEnabled
        ? sim.getCongestedEdges(snap.terrainEnabled, snap.terrainExaggeration)
        : [];
    mobilityFrameTickRef.current += 1;
    setMobilityStats(stats);
    overlayRef.current?.setProps({ layers: buildAllDeckLayers() });
  }, [
    mobilityTimeHours,
    mobilityVisible,
    mobilityOpacity,
    buildAllDeckLayers,
    setMobilityStats,
  ]);

  // Refresh visuals immediately when filter/style/terrain parameters change while paused
  useEffect(() => {
    const sim = mobilitySimRef.current;
    if (!sim || !mobilityVisible || mobilityPlaying) return;

    const stats = sim.refreshVisuals(
      {
        targetAgents: mobilityAgentCount,
        betaScale: mobilityBetaScale,
        enabledModes: mobilityEnabledModes,
        selectedBarangayName,
        barangayFilter: mobilityBarangayFilter,
        terrainEnabled,
        terrainExaggeration,
        opacity: mobilityOpacity,
        congestionEnabled: mobilityCongestionEnabled,
        congestionLoadScale: mobilityCongestionLoad,
        gravityLambdaKm: latestRef.current.mobilityGravityLambda,
        attrBlend: latestRef.current.mobilityAttrBlend,
        colorMode: mobilityColorMode,
      },
      mobilitySimTimeRef.current
    );
    mobilityCongestedRoadsRef.current =
      mobilityShowCongestedRoads && mobilityCongestionEnabled
        ? sim.getCongestedEdges(terrainEnabled, terrainExaggeration)
        : [];
    mobilityFrameTickRef.current += 1;
    setMobilityStats(stats);
    overlayRef.current?.setProps({ layers: buildAllDeckLayers() });
  }, [
    mobilityVisible,
    mobilityPlaying,
    mobilityAgentCount,
    mobilityBetaScale,
    mobilityEnabledModes,
    selectedBarangayName,
    mobilityBarangayFilter,
    mobilityCongestionEnabled,
    mobilityCongestionLoad,
    mobilityColorMode,
    mobilityShowCongestedRoads,
    terrainEnabled,
    terrainExaggeration,
    mobilityOpacity,
    mobilityLoadedTick,
    buildAllDeckLayers,
    setMobilityStats,
  ]);

  // Drive 60 FPS mobility animation loop when visible and playing
  useEffect(() => {
    if (!mobilityVisible || !mobilityPlaying || !mobilitySimRef.current) {
      return;
    }

    let rafId = 0;
    let lastFrameMs = performance.now();
    mobilityLastUiSyncMsRef.current = lastFrameMs;
    mobilityLastRibbonMsRef.current = lastFrameMs;

    const tick = (now: number) => {
      const sim = mobilitySimRef.current;
      if (!sim) return;

      const dtRealSec = Math.min(0.1, Math.max(0, (now - lastFrameMs) / 1000));
      lastFrameMs = now;

      const snap = latestRef.current;
      const nextHours =
        (mobilitySimTimeRef.current + (dtRealSec * snap.mobilitySpeed) / 3600) % 24;
      mobilitySimTimeRef.current = nextHours;

      const stats = sim.step(dtRealSec, snap.mobilitySpeed, nextHours, {
        targetAgents: snap.mobilityAgentCount,
        betaScale: snap.mobilityBetaScale,
        enabledModes: snap.mobilityEnabledModes,
        selectedBarangayName: snap.selectedBarangayName,
        barangayFilter: snap.mobilityBarangayFilter,
        terrainEnabled: snap.terrainEnabled,
        terrainExaggeration: snap.terrainExaggeration,
        opacity: snap.layerState.mobility?.opacity ?? 0.95,
        congestionEnabled: snap.mobilityCongestionEnabled,
        congestionLoadScale: snap.mobilityCongestionLoad,
        gravityLambdaKm: snap.mobilityGravityLambda,
        attrBlend: snap.mobilityAttrBlend,
        colorMode: snap.mobilityColorMode,
      });

      if (now - mobilityLastRibbonMsRef.current >= 500) {
        mobilityLastRibbonMsRef.current = now;
        mobilityCongestedRoadsRef.current =
          snap.mobilityShowCongestedRoads && snap.mobilityCongestionEnabled
            ? sim.getCongestedEdges(snap.terrainEnabled, snap.terrainExaggeration)
            : [];
      }

      const selAgent = selectedAgentRef.current;
      let agentArrived = false;
      if (selAgent) {
        const pos = sim.getAgentPosition(selAgent.index, selAgent.serial);
        if (!pos) {
          agentArrived = true;
        } else if (snap.followAgent) {
          mapRef.current?.jumpTo({ center: [pos[0], pos[1]] });
        }
      }

      mobilityFrameTickRef.current += 1;
      overlayRef.current?.setProps({ layers: buildAllDeckLayers() });

      if (selAgent && agentArrived) {
        // Trip finished: freeze the card at 100 %, stop following, keep route + endpoints.
        selectedAgentRef.current = null;
        setFollowAgent(false);
        const last = latestRef.current.selectedFeature;
        if (last && last.layerId === 'mobility') {
          setSelectedFeature({
            ...last,
            properties: {
              ...last.properties,
              arrived: true,
              progress_pct: 100,
              eta_min: 0,
              speed_kmh: 0,
              remaining_km: 0,
              travelled_km: last.properties?.distance_km ?? 0,
            },
          });
        }
      }

      if (now - mobilityLastUiSyncMsRef.current >= 250) {
        if (selectedAgentRef.current) {
          const liveSel = selectedAgentRef.current;
          const liveInfo = sim.getAgentInfo(
            liveSel.index,
            snap.terrainEnabled,
            snap.terrainExaggeration,
            snap.mobilityCongestionEnabled,
            liveSel.serial
          );
          const lastFeature = latestRef.current.selectedFeature;
          if (liveInfo && lastFeature && lastFeature.layerId === 'mobility') {
            setSelectedFeature({
              ...lastFeature,
              coordinates: liveInfo.coordinates,
              properties: buildAgentFeatureProps(liveInfo, false),
            });
          }
        }
        mobilityLastUiSyncMsRef.current = now;
        mobilityLastSyncedTimeRef.current = nextHours;
        setMobilityTimeHours(nextHours);
        setMobilityStats(stats);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [
    mobilityVisible,
    mobilityPlaying,
    mobilityLoadedTick,
    buildAllDeckLayers,
    setMobilityTimeHours,
    setMobilityStats,
  ]);

  // Keep cursor synchronized with measure and site-pick modes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor =
      measureMode !== 'off' || sitePickMode ? 'crosshair' : '';
  }, [measureMode, sitePickMode]);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOver(false);
    }
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(geo)?json$/i.test(file.name)) {
      onNotify('Drop a .geojson or .json file to mount it on the map');
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as GeoJSON.GeoJSON;
      const name = file.name.replace(/\.(geo)?json$/i, '') || 'Dropped GeoJSON';
      const def = createGeoJsonLayerDef({ name, geojson: parsed });
      registerLayer(def);
      onNotify(`Mounted "${name}"`);
    } catch {
      onNotify(`Could not parse "${file.name}" as GeoJSON`);
    }
  };

  return (
    <div
      className={`twin-viewport ${dragOver ? 'drop-active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
    >
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%' }}
        aria-label={`${getPlaceMeta().displayName} 3D Digital Twin Map`}
      />
      {cursorTelemetry && (
        <div
          className="hud-cursor-telemetry glass-panel"
          aria-live="off"
          title="Cursor coordinates & Copernicus GLO-30 ground elevation"
        >
          <Mountain size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span>
            {cursorTelemetry.lat.toFixed(4)}° N, {cursorTelemetry.lon.toFixed(4)}° E
          </span>
          <span className="telemetry-sep" aria-hidden="true">
            ·
          </span>
          <strong style={{ color: 'var(--text-primary)' }}>
            {formatElevation(cursorTelemetry.elev)}
          </strong>
        </div>
      )}
    </div>
  );
}
