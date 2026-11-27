import type { Layer as DeckLayer } from '@deck.gl/core';
import type maplibregl from 'maplibre-gl';

export type BasemapTheme = 'dark' | 'light' | 'satellite';

export type BuildingColorMode = 'height' | 'source' | 'class' | 'clay';

export type BuildingClassConfidenceFilter = 'all' | 'hide_inferred' | 'verified_only';

export type BarangayChoroplethMetric =
  | 'off'
  | 'building_density_per_km2'
  | 'commercial_share_pct'
  | 'poi_count'
  | 'built_coverage_pct'
  | 'mean_elev_m'
  | 'green_space_pct'
  | 'zonal_res_median'
  | 'zonal_com_median'
  | 'tree_cover_pct';

export interface BarangayAnalyticsHub {
  id: string;
  name: string;
  bclass: string;
  poi_count: number;
  center: [number, number];
}

export interface BarangayAnalyticsItem {
  id: string;
  name: string;
  centroid: [number, number];
  bbox: [number, number, number, number];
  area_km2: number;
  building_count: number;
  building_density_per_km2: number;
  footprint_m2: number;
  built_coverage_pct: number;
  est_gfa_m2: number;
  mean_height_m: number;
  max_height_m: number;
  commercial_count: number;
  commercial_share_pct: number;
  mixed_use_count: number;
  residential_count: number;
  industrial_count: number;
  civic_edu_health_count: number;
  unknown_count: number;
  poi_count: number;
  poi_density_per_km2: number;
  poi_by_category: Record<string, number>;
  mean_elev_m: number | null;
  min_elev_m: number | null;
  max_elev_m: number | null;
  low_lying_pct: number;
  green_space_pct: number;
  top_hubs: BarangayAnalyticsHub[];
  /** BIR zonal values (PHP/sqm), median over the barangay's street entries. */
  zonal_res_median?: number | null;
  zonal_res_max?: number | null;
  zonal_com_median?: number | null;
  /** ESA WorldCover 10 m shares of the barangay's area (scripts/compute_landcover_stats.py). */
  tree_cover_pct?: number;
  built_up_pct?: number;
  cropland_pct?: number;
  zonal_com_max?: number | null;
  zonal_entries?: number;
  zonal_top_commercial?: Array<{ street: string; vicinity: string; value: number }>;
}

export interface BarangayAnalyticsDataset {
  generated_at: string;
  citywide: {
    barangays: number;
    area_km2: number;
    building_count: number;
    footprint_m2: number;
    built_coverage_pct: number;
    est_gfa_m2: number;
    commercial_count: number;
    commercial_share_pct: number;
    mixed_use_count: number;
    residential_count: number;
    industrial_count: number;
    civic_edu_health_count: number;
    poi_count: number;
    mean_elev_m: number | null;
    low_lying_pct: number;
    green_space_pct: number;
  };
  barangays: BarangayAnalyticsItem[];
  zonal?: {
    source: string;
    department_order: string;
    effectivity: string;
    unit: string;
    note: string;
  };
}

export type LayerCategory =
  | 'base'
  | 'infrastructure'
  | 'environment'
  | 'mobility'
  | 'civic'
  | 'sensors'
  | 'custom';

export type LayerEngine = 'maplibre' | 'deck';

export interface CustomVectorStyle {
  fillColor: string;
  lineColor: string;
  lineWidth: number;
  pointRadius: number;
  extruded: boolean;
  elevationProperty: string | null;
  elevationScale: number;
}

export interface SelectedFeature {
  layerId: string;
  layerName: string;
  id?: string | number;
  coordinates?: [number, number];
  highlightedPoiId?: string | null;
  properties: Record<string, unknown>;
}

export interface TwinManifest {
  city: string;
  region: string;
  overture_release: string;
  generated_at: string;
  bbox: [number, number, number, number];
  center: [number, number];
  counts: {
    buildings: number;
    buildings_measured: number;
    buildings_floors: number;
    buildings_estimated: number;
    roads: number;
    base_features: number;
    barangays: number;
    osm_pois?: number;
    osm_pois_matched?: number;
    pois_total?: number;
    pois_matched?: number;
    poi_sources?: Record<string, number>;
    buildings_with_pois?: number;
    buildings_classified?: number;
    buildings_commercial?: number;
    buildings_mixed_use?: number;
    class_sources?: Record<string, number>;
    class_confidence?: Record<string, number>;
  };
  files: Record<string, string>;
}

export type AppView = 'explore' | 'analyze' | 'simulate' | 'reports';

export const APP_VIEWS: AppView[] = ['explore', 'analyze', 'simulate', 'reports'];

export interface BuildingPoiItem {
  osm_id: string;
  name?: string | null;
  category: string;
  poi_key: string;
  poi_value: string;
  mapped_bclass?: string | null;
  match_method: 'inside' | 'nearest' | string;
  match_distance_m: number;
  source?: string;
  confidence?: number | null;
  brand?: string;
  cuisine?: string;
  addr_street?: string;
  website?: string;
  phone?: string;
  updated?: string;
  /** Independent-evidence vote total (scripts/score_poi_votes.py). */
  vote_score?: number;
  trust?: 'verified' | 'unverified' | 'unrated';
  votes?: string[];
}

export interface BuildingPoiRecord {
  id: string;
  name: string | null;
  label: string | null;
  center: [number, number];
  bclass: string;
  class_source: string;
  class_confidence?: string;
  effective_height: number | null;
  height_source: string | null;
  num_floors: number | null;
  area_m2: number | null;
  primary_source: string | null;
  poi_count: number;
  poi_names?: string | null;
  poi_tags?: string | null;
  poi_match_distance_m?: number | null;
  pois: BuildingPoiItem[];
}

export interface SearchablePlaceItem {
  poiId: string;
  name: string;
  category: string;
  tag: string;
  source?: string;
  buildingId: string;
  buildingName?: string | null;
  buildingClass: string;
  coordinates: [number, number];
}

export interface BarangayIndexItem {
  id: string;
  name: string;
  level: 'city' | 'barangay';
  centroid: [number, number];
  bbox: [number, number, number, number];
}

export interface LandmarkItem {
  id: string;
  name: string;
  category: string;
  description: string;
  coordinates: [number, number];
  camera: {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  };
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'swatch' | 'line' | 'circle';
}

export interface DemManifest {
  source: string;
  resolution_m: number;
  generated_at: string;
  bbox: [number, number, number, number];
  stats: {
    min_m: number;
    max_m: number;
    mean_m: number;
    p50_m: number;
    p90_m: number;
  };
  grid: {
    file: string;
    width: number;
    height: number;
    bbox: [number, number, number, number];
    scale: number;
    nodata: number;
  };
  relief: {
    file: string;
    coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
  };
  slope: {
    file: string;
    coordinates: [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
  };
  contours: {
    file: string;
    interval_m: number;
    major_interval_m: number;
    feature_count: number;
  };
  terrarium: {
    tiles_template: string;
    minzoom: number;
    maxzoom: number;
    bounds: [number, number, number, number];
    tile_count: number;
  };
}

export interface MapLibreLayerContext {
  map: maplibregl.Map;
  visible: boolean;
  opacity: number;
  theme: BasemapTheme;
  buildingColorMode: BuildingColorMode;
  buildingConfidenceFilter?: BuildingClassConfidenceFilter;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  demManifest?: DemManifest | null;
  barangayChoropleth?: BarangayChoroplethMetric;
  selectedBarangayName?: string | null;
  poiCategoryFilter?: string;
  buildingPois?: Record<string, BuildingPoiRecord>;
  style?: CustomVectorStyle;
  selectedFeature: SelectedFeature | null;
  hoveredFeatureId: string | number | null;
}

export interface DeckLayerContext {
  visible: boolean;
  opacity: number;
  theme: BasemapTheme;
  buildingColorMode: BuildingColorMode;
  sunHour: number;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  sampleElevation?: (lon: number, lat: number) => number | null;
  style?: CustomVectorStyle;
  selectedFeature: SelectedFeature | null;
  onSelectFeature?: (feature: SelectedFeature) => void;
}

export interface LayerStateEntry {
  visible: boolean;
  opacity: number;
  style?: CustomVectorStyle;
}

export interface TwinLayerDefinition {
  id: string;
  name: string;
  description: string;
  category: LayerCategory;
  engine: LayerEngine;
  defaultVisible: boolean;
  defaultOpacity: number;
  removable?: boolean;
  sourceUrl?: string;
  sourceFormat?: 'geojson' | 'pmtiles';
  numericProperties?: string[];
  allProperties?: string[];
  defaultStyle?: CustomVectorStyle;
  legend?: LegendItem[];
  pickableLayerIds?: string[];
  maplibre?: (ctx: MapLibreLayerContext) => string[] | void;
  buildDeckLayer?: (ctx: DeckLayerContext) => DeckLayer | DeckLayer[] | null;
}
