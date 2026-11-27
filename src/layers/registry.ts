import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { type DemGridSampler, loadDemGrid } from '../utils/demSampler';
import { getEnvGoogleApiKey } from '../utils/googleTiles';
import {
  createEmptyMobilityStats,
  type MobilityBarangayFilter,
  type MobilityColorMode,
  type MobilityModeId,
  type MobilitySimStats,
} from '../utils/mobilityTypes';
import type { CatchmentGridData } from '../utils/siteSelection';
import { decodeUrlState, type UrlViewState } from '../utils/urlState';
import { BUILTIN_LAYERS } from './builtins';
import {
  createGeoJsonLayerDef,
  createRemotePmtilesLayerDef,
} from './customVectorLoader';
import type {
  AppView,
  BarangayAnalyticsDataset,
  BarangayChoroplethMetric,
  BarangayIndexItem,
  BasemapTheme,
  BuildingClassConfidenceFilter,
  BuildingColorMode,
  BuildingPoiRecord,
  CustomVectorStyle,
  DemManifest,
  LayerStateEntry,
  SearchablePlaceItem,
  SelectedFeature,
  TwinLayerDefinition,
  TwinManifest,
} from './types';

const STORAGE_KEY = 'bacolod_twin_prefs_v2';

interface PersistedRemoteLayer {
  id: string;
  name: string;
  sourceUrl: string;
  sourceFormat: 'geojson' | 'pmtiles';
  style?: CustomVectorStyle;
}

interface PersistedPrefs {
  theme?: BasemapTheme;
  buildingColorMode?: BuildingColorMode;
  buildingConfidenceFilter?: BuildingClassConfidenceFilter;
  terrainEnabled?: boolean;
  terrainExaggeration?: number;
  sunHour?: number;
  googleMapsApiKey?: string;
  layerState?: Record<string, LayerStateEntry>;
  remoteLayers?: PersistedRemoteLayer[];
}

export interface TwinStoreContextValue {
  layers: TwinLayerDefinition[];
  layerState: Record<string, LayerStateEntry>;
  theme: BasemapTheme;
  setTheme: (theme: BasemapTheme) => void;
  buildingColorMode: BuildingColorMode;
  setBuildingColorMode: (mode: BuildingColorMode) => void;
  buildingConfidenceFilter: BuildingClassConfidenceFilter;
  setBuildingConfidenceFilter: (filter: BuildingClassConfidenceFilter) => void;
  terrainEnabled: boolean;
  setTerrainEnabled: (enabled: boolean) => void;
  terrainExaggeration: number;
  setTerrainExaggeration: (exaggeration: number) => void;
  sunHour: number;
  setSunHour: (hour: number) => void;
  googleMapsApiKey: string;
  setGoogleMapsApiKey: (key: string) => void;
  selectedFeature: SelectedFeature | null;
  setSelectedFeature: (feature: SelectedFeature | null) => void;
  manifest: TwinManifest | null;
  demManifest: DemManifest | null;
  sampleElevation: (lon: number, lat: number) => number | null;
  barangays: BarangayIndexItem[];
  barangayAnalytics: BarangayAnalyticsDataset | null;
  catchmentGrid: CatchmentGridData | null;
  barangayChoropleth: BarangayChoroplethMetric;
  setBarangayChoropleth: (metric: BarangayChoroplethMetric) => void;
  selectedBarangayName: string | null;
  setSelectedBarangayName: (name: string | null) => void;
  poiCategoryFilter: string;
  setPoiCategoryFilter: (category: string) => void;
  buildingPois: Record<string, BuildingPoiRecord>;
  searchablePlaces: SearchablePlaceItem[];
  initialUrlState: UrlViewState;
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  mobilityPlaying: boolean;
  setMobilityPlaying: (playing: boolean) => void;
  mobilityTimeHours: number;
  setMobilityTimeHours: (hours: number) => void;
  mobilitySpeed: number;
  setMobilitySpeed: (speed: number) => void;
  mobilitySyncSun: boolean;
  setMobilitySyncSun: (sync: boolean) => void;
  mobilityAgentCount: number;
  setMobilityAgentCount: (count: number) => void;
  mobilityBetaScale: number;
  setMobilityBetaScale: (scale: number) => void;
  mobilityEnabledModes: Record<MobilityModeId, boolean>;
  toggleMobilityMode: (mode: MobilityModeId) => void;
  mobilityBarangayFilter: MobilityBarangayFilter;
  setMobilityBarangayFilter: (filter: MobilityBarangayFilter) => void;
  mobilityCongestionEnabled: boolean;
  setMobilityCongestionEnabled: (enabled: boolean) => void;
  mobilityCongestionLoad: number;
  mobilityGravityLambda: number;
  setMobilityGravityLambda: (km: number) => void;
  mobilityAttrBlend: number;
  setMobilityAttrBlend: (blend: number) => void;
  setMobilityCongestionLoad: (scale: number) => void;
  mobilityColorMode: MobilityColorMode;
  setMobilityColorMode: (mode: MobilityColorMode) => void;
  mobilityShowCongestedRoads: boolean;
  setMobilityShowCongestedRoads: (show: boolean) => void;
  mobilityStats: MobilitySimStats;
  setMobilityStats: (stats: MobilitySimStats) => void;
  selectedAgentRoute: [number, number, number][] | null;
  setSelectedAgentRoute: (route: [number, number, number][] | null) => void;
  followAgent: boolean;
  setFollowAgent: (follow: boolean) => void;
  registerLayer: (layer: TwinLayerDefinition) => void;
  unregisterLayer: (layerId: string) => void;
  toggleLayer: (layerId: string, visible?: boolean) => void;
  setOpacity: (layerId: string, opacity: number) => void;
  updateLayerStyle: (
    layerId: string,
    patch: Partial<CustomVectorStyle>
  ) => void;
  joinTabularMetrics: (
    layerId: string,
    rows: Record<string, unknown>[],
    joinKey?: string
  ) => void;
}

const TwinStoreContext = createContext<TwinStoreContextValue | null>(null);

function readPersistedPrefs(): PersistedPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedPrefs;
  } catch {
    return {};
  }
}

function writePersistedPrefs(prefs: PersistedPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota or private-mode failures
  }
}

function computePolygonBounds(
  coords: unknown
): { centroid: [number, number]; bbox: [number, number, number, number] } | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const visit = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 2 &&
      typeof node[0] === 'number' &&
      typeof node[1] === 'number'
    ) {
      minLon = Math.min(minLon, node[0]);
      maxLon = Math.max(maxLon, node[0]);
      minLat = Math.min(minLat, node[1]);
      maxLat = Math.max(maxLat, node[1]);
      return;
    }
    for (const child of node) {
      visit(child);
    }
  };

  visit(coords);
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  return {
    centroid: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
    bbox: [minLon, minLat, maxLon, maxLat],
  };
}

function parseBoundariesToBarangays(
  fc: GeoJSON.FeatureCollection
): BarangayIndexItem[] {
  if (!fc || !Array.isArray(fc.features)) return [];

  const items: BarangayIndexItem[] = [];
  for (let i = 0; i < fc.features.length; i += 1) {
    const feature = fc.features[i];
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const name = typeof props.name === 'string' ? props.name.trim() : '';
    if (!name) continue;

    const level: 'city' | 'barangay' =
      props.level === 'city' ? 'city' : 'barangay';

    const geomBounds = feature.geometry
      ? computePolygonBounds((feature.geometry as GeoJSON.Polygon).coordinates)
      : null;

    let centroid: [number, number] | null = null;
    if (
      typeof props.centroid_lon === 'number' &&
      typeof props.centroid_lat === 'number'
    ) {
      centroid = [props.centroid_lon, props.centroid_lat];
    } else if (
      Array.isArray(props.centroid) &&
      props.centroid.length >= 2 &&
      typeof props.centroid[0] === 'number' &&
      typeof props.centroid[1] === 'number'
    ) {
      centroid = [props.centroid[0], props.centroid[1]];
    } else if (geomBounds) {
      centroid = geomBounds.centroid;
    }

    let bbox: [number, number, number, number] | null = null;
    if (
      Array.isArray(props.bbox) &&
      props.bbox.length === 4 &&
      props.bbox.every((n) => typeof n === 'number')
    ) {
      bbox = props.bbox as [number, number, number, number];
    } else if (geomBounds) {
      bbox = geomBounds.bbox;
    }

    if (!centroid || !bbox) continue;

    items.push({
      id: String(props.id ?? `brgy-${i}`),
      name,
      level,
      centroid,
      bbox,
    });
  }

  return items.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'city' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function buildInitialLayerState(
  layers: TwinLayerDefinition[],
  persisted: PersistedPrefs,
  urlState: UrlViewState
): Record<string, LayerStateEntry> {
  const hiddenSet = new Set(urlState.hiddenLayers ?? []);
  const state: Record<string, LayerStateEntry> = {};

  for (const layer of layers) {
    const saved = persisted.layerState?.[layer.id];
    const visibleFromPref = saved?.visible ?? layer.defaultVisible;
    const visible = hiddenSet.has(layer.id) ? false : visibleFromPref;

    state[layer.id] = {
      visible:
        layer.id === 'terrain' && urlState.terrainEnabled !== undefined
          ? urlState.terrainEnabled
          : visible,
      opacity: saved?.opacity ?? layer.defaultOpacity,
      style: saved?.style ?? layer.defaultStyle,
    };
  }

  return state;
}

export function TwinStoreProvider({ children }: { children: ReactNode }) {
  const initialUrlState = useMemo(() => {
    if (typeof window === 'undefined') return {};
    return decodeUrlState(window.location.hash);
  }, []);

  const persisted = useMemo(() => readPersistedPrefs(), []);

  const [layers, setLayers] = useState<TwinLayerDefinition[]>(() => [
    ...BUILTIN_LAYERS,
  ]);
  const [layerState, setLayerState] = useState<Record<string, LayerStateEntry>>(
    () => buildInitialLayerState(BUILTIN_LAYERS, persisted, initialUrlState)
  );
  const [theme, setTheme] = useState<BasemapTheme>(
    () => initialUrlState.theme ?? persisted.theme ?? 'dark'
  );
  const [buildingColorMode, setBuildingColorMode] = useState<BuildingColorMode>(
    () => initialUrlState.colorMode ?? persisted.buildingColorMode ?? 'class'
  );
  const [buildingConfidenceFilter, setBuildingConfidenceFilter] =
    useState<BuildingClassConfidenceFilter>(
      () => persisted.buildingConfidenceFilter ?? 'all'
    );
  const [terrainEnabled, setTerrainEnabledState] = useState<boolean>(
    () => initialUrlState.terrainEnabled ?? persisted.terrainEnabled ?? true
  );
  const [terrainExaggeration, setTerrainExaggeration] = useState<number>(
    () =>
      initialUrlState.terrainExaggeration ??
      persisted.terrainExaggeration ??
      1.0
  );
  const [sunHour, setSunHour] = useState<number>(
    () => initialUrlState.sunHour ?? persisted.sunHour ?? 15.5
  );
  const [googleMapsApiKey, setGoogleMapsApiKey] = useState<string>(
    () => persisted.googleMapsApiKey ?? getEnvGoogleApiKey()
  );
  const [selectedFeature, setSelectedFeature] =
    useState<SelectedFeature | null>(null);
  const [manifest, setManifest] = useState<TwinManifest | null>(null);
  const [demManifest, setDemManifest] = useState<DemManifest | null>(null);
  const demSamplerRef = useRef<DemGridSampler | null>(null);
  const [barangays, setBarangays] = useState<BarangayIndexItem[]>([]);
  const [barangayAnalytics, setBarangayAnalytics] =
    useState<BarangayAnalyticsDataset | null>(null);
  const [catchmentGrid, setCatchmentGrid] = useState<CatchmentGridData | null>(
    null
  );
  const [barangayChoropleth, setBarangayChoroplethState] =
    useState<BarangayChoroplethMetric>('off');
  const [selectedBarangayName, setSelectedBarangayNameState] =
    useState<string | null>(null);
  const [poiCategoryFilter, setPoiCategoryFilter] = useState<string>('all');
  const [buildingPois, setBuildingPois] = useState<
    Record<string, BuildingPoiRecord>
  >({});
  const [searchablePlaces, setSearchablePlaces] = useState<
    SearchablePlaceItem[]
  >([]);
  const [activeView, setActiveViewState] = useState<AppView>(
    () => initialUrlState.view ?? 'explore'
  );
  const setActiveView = useCallback((view: AppView) => {
    setActiveViewState(view);
    if (typeof window === 'undefined') return;
    // Keep the shareable hash in step with the view (camera fields are rewritten by the map).
    const cur = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (view === 'explore') cur.delete('v');
    else cur.set('v', view);
    const next = cur.toString();
    window.history.replaceState(null, '', next ? `#${next}` : window.location.pathname + window.location.search);
  }, []);
  const [mobilityPlaying, setMobilityPlaying] = useState<boolean>(true);
  const [mobilityTimeHours, setMobilityTimeHours] = useState<number>(7.75);
  const [mobilitySpeed, setMobilitySpeed] = useState<number>(10);
  const [mobilitySyncSun, setMobilitySyncSun] = useState<boolean>(false);
  const [mobilityAgentCount, setMobilityAgentCount] = useState<number>(15000);
  const [mobilityBetaScale, setMobilityBetaScale] = useState<number>(1.0);
  const [mobilityEnabledModes, setMobilityEnabledModes] = useState<
    Record<MobilityModeId, boolean>
  >({
    walk: true,
    motorcycle: true,
    tricycle: true,
    car: true,
    puv: true,
  });
  const [mobilityBarangayFilter, setMobilityBarangayFilter] =
    useState<MobilityBarangayFilter>('all');
  const [mobilityCongestionEnabled, setMobilityCongestionEnabled] =
    useState<boolean>(true);
  const [mobilityGravityLambda, setMobilityGravityLambda] = useState<number>(3);
  const [mobilityAttrBlend, setMobilityAttrBlend] = useState<number>(0.5);
  const [mobilityCongestionLoad, setMobilityCongestionLoad] =
    useState<number>(1.0);
  const [mobilityColorMode, setMobilityColorMode] =
    useState<MobilityColorMode>('mode');
  const [mobilityShowCongestedRoads, setMobilityShowCongestedRoads] =
    useState<boolean>(true);
  const [mobilityStats, setMobilityStats] = useState<MobilitySimStats>(() =>
    createEmptyMobilityStats()
  );
  const [selectedAgentRoute, setSelectedAgentRoute] = useState<
    [number, number, number][] | null
  >(null);
  const [followAgent, setFollowAgent] = useState<boolean>(false);

  useEffect(() => {
    if (!mobilitySyncSun) return;
    const clamped = Math.max(6, Math.min(19, mobilityTimeHours));
    setSunHour(clamped);
  }, [mobilitySyncSun, mobilityTimeHours]);

  // Fetch local Bacolod manifest, barangay index, building-linked POIs, and DEM grid on mount
  useEffect(() => {
    const base = import.meta.env?.BASE_URL ?? '/';
    const controller = new AbortController();

    async function loadCityMetadata() {
      try {
        const manifestRes = await fetch(`${base}data/bacolod/manifest.json`, {
          signal: controller.signal,
        });
        if (manifestRes.ok) {
          const data = (await manifestRes.json()) as TwinManifest;
          setManifest(data);
        }
      } catch {
        // Ignore abort/offline during tests
      }

      try {
        const boundariesRes = await fetch(
          `${base}data/bacolod/boundaries.geojson`,
          { signal: controller.signal }
        );
        if (boundariesRes.ok) {
          const fc = (await boundariesRes.json()) as GeoJSON.FeatureCollection;
          setBarangays(parseBoundariesToBarangays(fc));
        }
      } catch {
        // Ignore abort/offline during tests
      }

      try {
        const poisRes = await fetch(`${base}data/bacolod/building_pois.json`, {
          signal: controller.signal,
        });
        if (poisRes.ok) {
          const recordMap = (await poisRes.json()) as Record<
            string,
            BuildingPoiRecord
          >;
          setBuildingPois(recordMap);

          const places: SearchablePlaceItem[] = [];
          const seen = new Set<string>();
          for (const rec of Object.values(recordMap)) {
            if (!Array.isArray(rec.center) || rec.center.length < 2) continue;
            for (const poi of rec.pois ?? []) {
              const pname =
                typeof poi.name === 'string' ? poi.name.trim() : '';
              if (!pname) continue;
              const dedupKey = `${rec.id}::${pname.toLowerCase()}`;
              if (seen.has(dedupKey)) continue;
              seen.add(dedupKey);
              places.push({
                poiId: poi.osm_id,
                name: pname,
                category: poi.category || 'other',
                tag: poi.poi_value
                  ? `${poi.poi_key}=${poi.poi_value}`
                  : poi.poi_key,
                source: poi.source ?? 'osm',
                buildingId: rec.id,
                buildingName: rec.name ?? null,
                buildingClass: rec.bclass,
                coordinates: [rec.center[0], rec.center[1]],
              });
            }
          }
          places.sort((a, b) => a.name.localeCompare(b.name));
          setSearchablePlaces(places);
        }
      } catch {
        // Ignore abort/offline during tests
      }

      try {
        const analyticsRes = await fetch(
          `${base}data/bacolod/barangay_analytics.json`,
          { signal: controller.signal }
        );
        if (analyticsRes.ok) {
          const data = (await analyticsRes.json()) as BarangayAnalyticsDataset;
          setBarangayAnalytics(data);
        }
      } catch {
        // Ignore abort/offline during tests
      }

      try {
        const gridRes = await fetch(
          `${base}data/bacolod/catchment_grid.json`,
          { signal: controller.signal }
        );
        if (gridRes.ok) {
          const data = (await gridRes.json()) as CatchmentGridData;
          setCatchmentGrid(data);
        }
      } catch {
        // Ignore abort/offline during tests
      }

      const loadedDem = await loadDemGrid(base);
      if (loadedDem && !controller.signal.aborted) {
        demSamplerRef.current = loadedDem.sampler;
        setDemManifest(loadedDem.manifest);
      }
    }

    void loadCityMetadata();
    return () => controller.abort();
  }, []);

  // Restore persisted remote URL layers once
  useEffect(() => {
    const remotes = persisted.remoteLayers;
    if (!remotes || remotes.length === 0) return;

    let cancelled = false;
    async function restoreRemoteLayers() {
      for (const item of remotes!) {
        try {
          if (item.sourceFormat === 'pmtiles') {
            const def = await createRemotePmtilesLayerDef({
              id: item.id,
              name: item.name,
              url: item.sourceUrl,
            });
            if (cancelled) return;
            setLayers((prev) =>
              prev.some((l) => l.id === def.id) ? prev : [...prev, def]
            );
            setLayerState((prev) => ({
              ...prev,
              [def.id]: prev[def.id] ?? {
                visible: true,
                opacity: def.defaultOpacity,
                style: item.style ?? def.defaultStyle,
              },
            }));
          } else if (item.sourceFormat === 'geojson') {
            const res = await fetch(item.sourceUrl);
            if (!res.ok) continue;
            const geojson = (await res.json()) as GeoJSON.GeoJSON;
            const def = createGeoJsonLayerDef({
              id: item.id,
              name: item.name,
              geojson,
              sourceUrl: item.sourceUrl,
              defaultStyle: item.style,
            });
            if (cancelled) return;
            setLayers((prev) =>
              prev.some((l) => l.id === def.id) ? prev : [...prev, def]
            );
            setLayerState((prev) => ({
              ...prev,
              [def.id]: prev[def.id] ?? {
                visible: true,
                opacity: def.defaultOpacity,
                style: item.style ?? def.defaultStyle,
              },
            }));
          }
        } catch {
          // Skip unreachable remote URL on reload
        }
      }
    }

    void restoreRemoteLayers();
    return () => {
      cancelled = true;
    };
  }, [persisted.remoteLayers]);

  // Persist user preferences & remote URL layers
  useEffect(() => {
    const remoteLayers: PersistedRemoteLayer[] = layers
      .filter((l) => Boolean(l.sourceUrl) && Boolean(l.sourceFormat))
      .map((l) => ({
        id: l.id,
        name: l.name,
        sourceUrl: l.sourceUrl!,
        sourceFormat: l.sourceFormat!,
        style: layerState[l.id]?.style ?? l.defaultStyle,
      }));

    writePersistedPrefs({
      theme,
      buildingColorMode,
      buildingConfidenceFilter,
      terrainEnabled,
      terrainExaggeration,
      sunHour,
      googleMapsApiKey,
      layerState,
      remoteLayers,
    });
  }, [
    theme,
    buildingColorMode,
    buildingConfidenceFilter,
    terrainEnabled,
    terrainExaggeration,
    sunHour,
    googleMapsApiKey,
    layerState,
    layers,
  ]);

  const setTerrainEnabled = useCallback((enabled: boolean) => {
    setTerrainEnabledState(enabled);
    setLayerState((prev) => ({
      ...prev,
      terrain: {
        visible: enabled,
        opacity: prev.terrain?.opacity ?? 0.45,
        style: prev.terrain?.style,
      },
    }));
  }, []);

  const setBarangayChoropleth = useCallback(
    (metric: BarangayChoroplethMetric) => {
      setBarangayChoroplethState(metric);
      if (metric !== 'off') {
        setLayerState((prev) => ({
          ...prev,
          boundaries: {
            ...(prev.boundaries ?? { opacity: 0.8 }),
            visible: true,
          },
        }));
      }
    },
    []
  );

  const setSelectedBarangayName = useCallback((name: string | null) => {
    setSelectedBarangayNameState(name);
    if (name) {
      setLayerState((prev) => ({
        ...prev,
        boundaries: {
          ...(prev.boundaries ?? { opacity: 0.8 }),
          visible: true,
        },
      }));
    }
  }, []);

  const registerLayer = useCallback((layer: TwinLayerDefinition) => {
    setLayers((prev) => {
      const idx = prev.findIndex((item) => item.id === layer.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = layer;
        return next;
      }
      return [...prev, layer];
    });

    setLayerState((prev) => ({
      ...prev,
      [layer.id]: prev[layer.id] ?? {
        visible: layer.defaultVisible,
        opacity: layer.defaultOpacity,
        style: layer.defaultStyle,
      },
    }));
  }, []);

  const unregisterLayer = useCallback((layerId: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== layerId));
    setLayerState((prev) => {
      if (!(layerId in prev)) return prev;
      const next = { ...prev };
      delete next[layerId];
      return next;
    });
    setSelectedFeature((prev) =>
      prev?.layerId === layerId ? null : prev
    );
  }, []);

  const toggleLayer = useCallback((layerId: string, visible?: boolean) => {
    setLayerState((prev) => {
      const current = prev[layerId] ?? { visible: true, opacity: 1 };
      const nextVisible = visible ?? !current.visible;
      if (layerId === 'terrain') {
        setTerrainEnabledState(nextVisible);
      }
      return {
        ...prev,
        [layerId]: {
          ...current,
          visible: nextVisible,
        },
      };
    });
  }, []);

  const setOpacity = useCallback((layerId: string, opacity: number) => {
    const clamped = Math.max(0, Math.min(1, opacity));
    setLayerState((prev) => {
      const current = prev[layerId] ?? { visible: true, opacity: clamped };
      return {
        ...prev,
        [layerId]: {
          ...current,
          opacity: clamped,
        },
      };
    });
  }, []);

  const updateLayerStyle = useCallback(
    (layerId: string, patch: Partial<CustomVectorStyle>) => {
      setLayerState((prev) => {
        const current = prev[layerId] ?? { visible: true, opacity: 0.85 };
        const baseStyle: CustomVectorStyle = current.style ?? {
          fillColor: '#0ea5e9',
          lineColor: '#38bdf8',
          lineWidth: 2,
          pointRadius: 6,
          extruded: false,
          elevationProperty: null,
          elevationScale: 1,
        };
        return {
          ...prev,
          [layerId]: {
            ...current,
            style: { ...baseStyle, ...patch },
          },
        };
      });
    },
    []
  );

  const joinTabularMetrics = useCallback(
    (
      layerId: string,
      rows: Record<string, unknown>[],
      joinKey = 'id'
    ) => {
      if (!rows || rows.length === 0) return;
      const lookup = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const keyVal = row[joinKey];
        if (keyVal !== undefined && keyVal !== null) {
          lookup.set(String(keyVal), row);
        }
      }
      if (lookup.size === 0) return;

      const numericKeys = new Set<string>();
      const allKeys = new Set<string>();
      for (const row of rows) {
        for (const [k, v] of Object.entries(row)) {
          allKeys.add(k);
          if (typeof v === 'number' && Number.isFinite(v)) {
            numericKeys.add(k);
          }
        }
      }

      setLayers((prev) =>
        prev.map((layer) => {
          if (layer.id !== layerId) return layer;
          const mergedAll = Array.from(
            new Set([...(layer.allProperties ?? []), ...allKeys])
          );
          const mergedNumeric = Array.from(
            new Set([...(layer.numericProperties ?? []), ...numericKeys])
          );
          return {
            ...layer,
            allProperties: mergedAll,
            numericProperties: mergedNumeric,
          };
        })
      );
    },
    []
  );

  const sampleElevation = useCallback((lon: number, lat: number) => {
    return demSamplerRef.current?.sampleElevation(lon, lat) ?? null;
  }, []);

  const toggleMobilityMode = useCallback((mode: MobilityModeId) => {
    setMobilityEnabledModes((prev) => ({
      ...prev,
      [mode]: !prev[mode],
    }));
  }, []);

  const value = useMemo<TwinStoreContextValue>(
    () => ({
      layers,
      layerState,
      theme,
      setTheme,
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
      selectedFeature,
      setSelectedFeature,
      manifest,
      demManifest,
      sampleElevation,
      barangays,
      barangayAnalytics,
      catchmentGrid,
      barangayChoropleth,
      setBarangayChoropleth,
      selectedBarangayName,
      setSelectedBarangayName,
      poiCategoryFilter,
      setPoiCategoryFilter,
      buildingPois,
      searchablePlaces,
      initialUrlState,
      activeView,
      setActiveView,
      mobilityPlaying,
      setMobilityPlaying,
      mobilityTimeHours,
      setMobilityTimeHours,
      mobilitySpeed,
      setMobilitySpeed,
      mobilitySyncSun,
      setMobilitySyncSun,
      mobilityAgentCount,
      setMobilityAgentCount,
      mobilityBetaScale,
      setMobilityBetaScale,
      mobilityEnabledModes,
      toggleMobilityMode,
      mobilityBarangayFilter,
      setMobilityBarangayFilter,
      mobilityCongestionEnabled,
      setMobilityCongestionEnabled,
      mobilityCongestionLoad,
      mobilityGravityLambda,
      setMobilityGravityLambda,
      mobilityAttrBlend,
      setMobilityAttrBlend,
      setMobilityCongestionLoad,
      mobilityColorMode,
      setMobilityColorMode,
      mobilityShowCongestedRoads,
      setMobilityShowCongestedRoads,
      mobilityStats,
      setMobilityStats,
      selectedAgentRoute,
      setSelectedAgentRoute,
      followAgent,
      setFollowAgent,
      registerLayer,
      unregisterLayer,
      toggleLayer,
      setOpacity,
      updateLayerStyle,
      joinTabularMetrics,
    }),
    [
      layers,
      layerState,
      theme,
      buildingColorMode,
      buildingConfidenceFilter,
      terrainEnabled,
      setTerrainEnabled,
      terrainExaggeration,
      sunHour,
      googleMapsApiKey,
      selectedFeature,
      manifest,
      demManifest,
      sampleElevation,
      barangays,
      barangayAnalytics,
      catchmentGrid,
      barangayChoropleth,
      setBarangayChoropleth,
      selectedBarangayName,
      setSelectedBarangayName,
      poiCategoryFilter,
      setPoiCategoryFilter,
      buildingPois,
      searchablePlaces,
      initialUrlState,
      activeView,
      setActiveView,
      mobilityPlaying,
      mobilityTimeHours,
      mobilitySpeed,
      mobilitySyncSun,
      mobilityAgentCount,
      mobilityBetaScale,
      mobilityEnabledModes,
      toggleMobilityMode,
      mobilityBarangayFilter,
      mobilityCongestionEnabled,
      mobilityCongestionLoad,
      mobilityGravityLambda,
      mobilityAttrBlend,
      mobilityColorMode,
      mobilityShowCongestedRoads,
      mobilityStats,
      selectedAgentRoute,
      followAgent,
      registerLayer,
      unregisterLayer,
      toggleLayer,
      setOpacity,
      updateLayerStyle,
      joinTabularMetrics,
    ]
  );

  return createElement(TwinStoreContext.Provider, { value }, children);
}

export function useTwinStore(): TwinStoreContextValue {
  const ctx = useContext(TwinStoreContext);
  if (!ctx) {
    throw new Error('useTwinStore must be used inside a TwinStoreProvider');
  }
  return ctx;
}
