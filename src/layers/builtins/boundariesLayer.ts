import type { ExpressionSpecification } from 'maplibre-gl';
import type {
  BarangayChoroplethMetric,
  LegendItem,
  TwinLayerDefinition,
} from '../types';
import { placeFile } from '../../utils/place';

function getBoundariesUrl(): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base}${placeFile('boundaries.geojson')}`;
}

export const BOUNDARIES_SOURCE_ID = 'bacolod-boundaries';
export const BOUNDARIES_FILL_ID = 'boundaries-fill';
export const BOUNDARIES_BARANGAY_LINE_ID = 'boundaries-barangay-line';
export const BOUNDARIES_CITY_LINE_ID = 'boundaries-city-line';
export const BOUNDARIES_SELECTED_FILL_ID = 'boundaries-selected-fill';
export const BOUNDARIES_SELECTED_GLOW_ID = 'boundaries-selected-glow';
export const BOUNDARIES_SELECTED_LINE_ID = 'boundaries-selected-line';
export const BOUNDARIES_LABEL_ID = 'boundaries-label';
export const BOUNDARIES_SELECTED_LABEL_ID = 'boundaries-selected-label';

export interface ChoroplethMetricMeta {
  metric: Exclude<BarangayChoroplethMetric, 'off'>;
  label: string;
  shortLabel: string;
  unit: string;
  stops: Array<[number, string]>;
}

export const CHOROPLETH_CONFIG: Record<
  Exclude<BarangayChoroplethMetric, 'off'>,
  ChoroplethMetricMeta
> = {
  building_density_per_km2: {
    metric: 'building_density_per_km2',
    label: 'Building Density (/km²)',
    shortLabel: 'Density',
    unit: '/km²',
    stops: [
      [0, '#0f172a'],
      [500, '#0284c7'],
      [2000, '#14b8a6'],
      [5000, '#f59e0b'],
      [9000, '#ef4444'],
    ],
  },
  commercial_share_pct: {
    metric: 'commercial_share_pct',
    label: 'Commercial Share (%)',
    shortLabel: 'Commercial %',
    unit: '%',
    stops: [
      [0, '#1e293b'],
      [2, '#38bdf8'],
      [6, '#2dd4bf'],
      [12, '#f59e0b'],
      [25, '#ec4899'],
    ],
  },
  poi_count: {
    metric: 'poi_count',
    label: 'Linked Places (POIs)',
    shortLabel: 'POIs',
    unit: ' POIs',
    stops: [
      [0, '#1e293b'],
      [15, '#0284c7'],
      [60, '#10b981'],
      [180, '#f59e0b'],
      [450, '#ef4444'],
    ],
  },
  built_coverage_pct: {
    metric: 'built_coverage_pct',
    label: 'Built Coverage (%)',
    shortLabel: 'Built %',
    unit: '%',
    stops: [
      [0, '#1e293b'],
      [5, '#38bdf8'],
      [15, '#2dd4bf'],
      [30, '#f59e0b'],
      [50, '#ef4444'],
    ],
  },
  mean_elev_m: {
    metric: 'mean_elev_m',
    label: 'Mean Elevation (m ASL)',
    shortLabel: 'Elevation',
    unit: ' m',
    stops: [
      [0, '#ef4444'],
      [3, '#f59e0b'],
      [10, '#2dd4bf'],
      [35, '#10b981'],
      [120, '#38bdf8'],
    ],
  },
  green_space_pct: {
    metric: 'green_space_pct',
    label: 'Green Space (%)',
    shortLabel: 'Green %',
    unit: '%',
    stops: [
      [0, '#1e293b'],
      [2, '#38bdf8'],
      [8, '#22c55e'],
      [20, '#16a34a'],
      [40, '#15803d'],
    ],
  },
  pop_density_per_km2: {
    metric: 'pop_density_per_km2',
    label: 'Population Density (residents/km², PSA 2020)',
    shortLabel: 'Pop./km²',
    unit: '/km²',
    stops: [
      [0, '#0f172a'],
      [500, '#0284c7'],
      [3000, '#14b8a6'],
      [10000, '#f59e0b'],
      [30000, '#ef4444'],
    ],
  },
  children_pct: {
    metric: 'children_pct',
    label: 'Children aged 0–14 (% of residents, PSA 2020)',
    shortLabel: 'Children %',
    unit: '%',
    stops: [
      [18, '#1e293b'],
      [22, '#38bdf8'],
      [26, '#2dd4bf'],
      [30, '#f59e0b'],
      [34, '#ef4444'],
    ],
  },
  seniors_pct: {
    metric: 'seniors_pct',
    label: 'Seniors aged 60+ (% of residents, PSA 2020)',
    shortLabel: 'Seniors %',
    unit: '%',
    stops: [
      [5, '#1e293b'],
      [7, '#38bdf8'],
      [9, '#a78bfa'],
      [11, '#f59e0b'],
      [14, '#ef4444'],
    ],
  },
  tree_cover_pct: {
    metric: 'tree_cover_pct',
    label: 'Tree Cover (% of area, ESA WorldCover)',
    shortLabel: 'Tree %',
    unit: '%',
    stops: [
      [0, '#1e293b'],
      [10, '#38bdf8'],
      [25, '#22c55e'],
      [45, '#16a34a'],
      [70, '#14532d'],
    ],
  },
  zonal_res_median: {
    metric: 'zonal_res_median',
    label: 'Residential Land Value (BIR zonal, ₱/m²)',
    shortLabel: 'Land ₱ (res)',
    unit: '',
    stops: [
      [1500, '#1e293b'],
      [3000, '#38bdf8'],
      [6000, '#2dd4bf'],
      [12000, '#f59e0b'],
      [20000, '#ef4444'],
    ],
  },
  zonal_com_median: {
    metric: 'zonal_com_median',
    label: 'Commercial Land Value (BIR zonal, ₱/m²)',
    shortLabel: 'Land ₱ (com)',
    unit: '',
    stops: [
      [3000, '#1e293b'],
      [6000, '#38bdf8'],
      [15000, '#2dd4bf'],
      [30000, '#f59e0b'],
      [45000, '#ec4899'],
    ],
  },
};

export function getChoroplethLegend(metric: BarangayChoroplethMetric): LegendItem[] {
  if (metric === 'off') return [];
  const cfg = CHOROPLETH_CONFIG[metric];
  return cfg.stops.map(([val, color]) => ({
    label: cfg.unit === '' ? `₱${val.toLocaleString()}` : `${val}${cfg.unit}`,
    color,
    shape: 'swatch',
  }));
}

export const boundariesLayer: TwinLayerDefinition = {
  id: 'boundaries',
  name: 'Barangay Boundaries',
  description:
    'Bacolod City administrative limits and 61 barangay boundaries with choropleth analytics.',
  category: 'civic',
  engine: 'maplibre',
  defaultVisible: true,
  defaultOpacity: 0.8,
  pickableLayerIds: [BOUNDARIES_FILL_ID],
  legend: [
    { label: 'City Boundary', color: '#f59e0b', shape: 'line' },
    { label: 'Barangay Border', color: '#38bdf8', shape: 'line' },
  ],
  maplibre(ctx) {
    const {
      map,
      visible,
      opacity,
      theme,
      barangayChoropleth,
      selectedBarangayName,
    } = ctx;

    if (!map.getSource(BOUNDARIES_SOURCE_ID)) {
      map.addSource(BOUNDARIES_SOURCE_ID, {
        type: 'geojson',
        data: getBoundariesUrl(),
        generateId: true,
      });
    }

    const visibility = visible ? 'visible' : 'none';
    const barangayColor = theme === 'light' ? '#0284c7' : '#38bdf8';
    const cityColor = theme === 'light' ? '#d97706' : '#fbbf24';
    const labelColor = theme === 'light' ? '#0f172a' : '#e2e8f0';
    const labelHalo = theme === 'light' ? '#ffffff' : '#090d16';

    const activeMetric =
      barangayChoropleth && barangayChoropleth !== 'off'
        ? CHOROPLETH_CONFIG[barangayChoropleth]
        : null;

    const fillColor: string | ExpressionSpecification = activeMetric
      ? ([
          'interpolate',
          ['linear'],
          ['coalesce', ['get', activeMetric.metric], 0],
          ...activeMetric.stops.flatMap(([val, color]) => [val, color]),
        ] as unknown as ExpressionSpecification)
      : barangayColor;
    const fillOpacity = activeMetric ? 0.48 * opacity : 0.02 * opacity;
    const lineOpacity = activeMetric ? 0.9 * opacity : 0.72 * opacity;

    if (!map.getLayer(BOUNDARIES_FILL_ID)) {
      map.addLayer({
        id: BOUNDARIES_FILL_ID,
        type: 'fill',
        source: BOUNDARIES_SOURCE_ID,
        filter: ['==', ['get', 'level'], 'barangay'],
        layout: { visibility },
        paint: {
          'fill-color': fillColor,
          'fill-opacity': fillOpacity,
        },
      });
    } else {
      map.setLayoutProperty(BOUNDARIES_FILL_ID, 'visibility', visibility);
      map.setPaintProperty(BOUNDARIES_FILL_ID, 'fill-color', fillColor);
      map.setPaintProperty(BOUNDARIES_FILL_ID, 'fill-opacity', fillOpacity);
    }

    if (!map.getLayer(BOUNDARIES_BARANGAY_LINE_ID)) {
      map.addLayer({
        id: BOUNDARIES_BARANGAY_LINE_ID,
        type: 'line',
        source: BOUNDARIES_SOURCE_ID,
        filter: ['==', ['get', 'level'], 'barangay'],
        layout: { visibility },
        paint: {
          'line-color': barangayColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, 1.8],
          'line-dasharray': [3, 2],
          'line-opacity': lineOpacity,
        },
      });
    } else {
      map.setLayoutProperty(BOUNDARIES_BARANGAY_LINE_ID, 'visibility', visibility);
      map.setPaintProperty(BOUNDARIES_BARANGAY_LINE_ID, 'line-color', barangayColor);
      map.setPaintProperty(BOUNDARIES_BARANGAY_LINE_ID, 'line-opacity', lineOpacity);
    }

    if (!map.getLayer(BOUNDARIES_CITY_LINE_ID)) {
      map.addLayer({
        id: BOUNDARIES_CITY_LINE_ID,
        type: 'line',
        source: BOUNDARIES_SOURCE_ID,
        filter: ['==', ['get', 'level'], 'city'],
        layout: { visibility },
        paint: {
          'line-color': cityColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 15, 3.0],
          'line-opacity': 0.9 * opacity,
        },
      });
    } else {
      map.setLayoutProperty(BOUNDARIES_CITY_LINE_ID, 'visibility', visibility);
      map.setPaintProperty(BOUNDARIES_CITY_LINE_ID, 'line-color', cityColor);
      map.setPaintProperty(
        BOUNDARIES_CITY_LINE_ID,
        'line-opacity',
        0.9 * opacity
      );
    }

    const hasSelection = Boolean(selectedBarangayName);
    const selectedVisibility = visible && hasSelection ? 'visible' : 'none';
    const selectedFilter = [
      'all',
      ['==', ['get', 'level'], 'barangay'],
      ['==', ['get', 'name'], selectedBarangayName ?? ''],
    ] as unknown as ExpressionSpecification;
    const selectedStrokeColor = theme === 'light' ? '#d97706' : '#fde047';
    const selectedGlowColor = theme === 'light' ? '#f59e0b' : '#fde047';
    const selectedFillColor = activeMetric
      ? '#ffffff'
      : theme === 'light'
        ? '#f59e0b'
        : '#fde047';
    const selectedFillOpacity = activeMetric ? 0.16 * opacity : 0.2 * opacity;

    if (!map.getLayer(BOUNDARIES_SELECTED_FILL_ID)) {
      map.addLayer({
        id: BOUNDARIES_SELECTED_FILL_ID,
        type: 'fill',
        source: BOUNDARIES_SOURCE_ID,
        filter: selectedFilter,
        layout: { visibility: selectedVisibility },
        paint: {
          'fill-color': selectedFillColor,
          'fill-opacity': selectedFillOpacity,
        },
      });
    } else {
      map.setFilter(BOUNDARIES_SELECTED_FILL_ID, selectedFilter);
      map.setLayoutProperty(
        BOUNDARIES_SELECTED_FILL_ID,
        'visibility',
        selectedVisibility
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_FILL_ID,
        'fill-color',
        selectedFillColor
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_FILL_ID,
        'fill-opacity',
        selectedFillOpacity
      );
    }

    if (!map.getLayer(BOUNDARIES_SELECTED_GLOW_ID)) {
      map.addLayer({
        id: BOUNDARIES_SELECTED_GLOW_ID,
        type: 'line',
        source: BOUNDARIES_SOURCE_ID,
        filter: selectedFilter,
        layout: {
          visibility: selectedVisibility,
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': selectedGlowColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 15, 12],
          'line-blur': 6,
          'line-opacity': 0.5 * opacity,
        },
      });
    } else {
      map.setFilter(BOUNDARIES_SELECTED_GLOW_ID, selectedFilter);
      map.setLayoutProperty(
        BOUNDARIES_SELECTED_GLOW_ID,
        'visibility',
        selectedVisibility
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_GLOW_ID,
        'line-color',
        selectedGlowColor
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_GLOW_ID,
        'line-opacity',
        0.5 * opacity
      );
    }

    if (!map.getLayer(BOUNDARIES_SELECTED_LINE_ID)) {
      map.addLayer({
        id: BOUNDARIES_SELECTED_LINE_ID,
        type: 'line',
        source: BOUNDARIES_SOURCE_ID,
        filter: selectedFilter,
        layout: {
          visibility: selectedVisibility,
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': selectedStrokeColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.8, 15, 4.5],
          'line-opacity': 0.98 * opacity,
        },
      });
    } else {
      map.setFilter(BOUNDARIES_SELECTED_LINE_ID, selectedFilter);
      map.setLayoutProperty(
        BOUNDARIES_SELECTED_LINE_ID,
        'visibility',
        selectedVisibility
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_LINE_ID,
        'line-color',
        selectedStrokeColor
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_LINE_ID,
        'line-opacity',
        0.98 * opacity
      );
    }

    if (!map.getLayer(BOUNDARIES_LABEL_ID)) {
      map.addLayer({
        id: BOUNDARIES_LABEL_ID,
        type: 'symbol',
        source: BOUNDARIES_SOURCE_ID,
        filter: ['==', ['get', 'level'], 'barangay'],
        minzoom: 12,
        layout: {
          visibility,
          'text-field': ['get', 'name'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 15, 13],
          'text-letter-spacing': 0.04,
          'text-max-width': 10,
        },
        paint: {
          'text-color': labelColor,
          'text-halo-color': labelHalo,
          'text-halo-width': 1.5,
          'text-opacity': 0.85 * opacity,
        },
      });
    } else {
      map.setLayoutProperty(BOUNDARIES_LABEL_ID, 'visibility', visibility);
      map.setPaintProperty(BOUNDARIES_LABEL_ID, 'text-color', labelColor);
      map.setPaintProperty(BOUNDARIES_LABEL_ID, 'text-halo-color', labelHalo);
      map.setPaintProperty(BOUNDARIES_LABEL_ID, 'text-opacity', 0.85 * opacity);
    }

    if (!map.getLayer(BOUNDARIES_SELECTED_LABEL_ID)) {
      map.addLayer({
        id: BOUNDARIES_SELECTED_LABEL_ID,
        type: 'symbol',
        source: BOUNDARIES_SOURCE_ID,
        filter: selectedFilter,
        minzoom: 10,
        layout: {
          visibility: selectedVisibility,
          'text-field': ['get', 'name'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 15, 15],
          'text-letter-spacing': 0.05,
          'text-max-width': 12,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': selectedStrokeColor,
          'text-halo-color': labelHalo,
          'text-halo-width': 2.2,
          'text-opacity': 0.98 * opacity,
        },
      });
    } else {
      map.setFilter(BOUNDARIES_SELECTED_LABEL_ID, selectedFilter);
      map.setLayoutProperty(
        BOUNDARIES_SELECTED_LABEL_ID,
        'visibility',
        selectedVisibility
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_LABEL_ID,
        'text-color',
        selectedStrokeColor
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_LABEL_ID,
        'text-halo-color',
        labelHalo
      );
      map.setPaintProperty(
        BOUNDARIES_SELECTED_LABEL_ID,
        'text-opacity',
        0.98 * opacity
      );
    }

    return [BOUNDARIES_FILL_ID];
  },
};
