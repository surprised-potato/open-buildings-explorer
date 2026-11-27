import type { ExpressionSpecification } from 'maplibre-gl';
import type {
  BuildingClassConfidenceFilter,
  BuildingColorMode,
  LegendItem,
  TwinLayerDefinition,
} from '../types';
import { placeFile, placePmtiles } from '../../utils/place';

function getOriginAndBase(): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${origin}${base}`;
}

export function getBuildingLegend(mode: BuildingColorMode): LegendItem[] {
  switch (mode) {
    case 'source':
      return [
        { label: 'Measured Height', color: '#10b981', shape: 'swatch' },
        { label: 'From Floor Count', color: '#3b82f6', shape: 'swatch' },
        { label: 'Class/Area Heuristic', color: '#f59e0b', shape: 'swatch' },
      ];
    case 'class':
      return [
        { label: 'Residential', color: '#60a5fa', shape: 'swatch' },
        { label: 'Commercial / Retail', color: '#f59e0b', shape: 'swatch' },
        { label: 'Mixed-Use', color: '#ec4899', shape: 'swatch' },
        { label: 'Office', color: '#818cf8', shape: 'swatch' },
        { label: 'Civic / Edu', color: '#2dd4bf', shape: 'swatch' },
        { label: 'Healthcare', color: '#f43f5e', shape: 'swatch' },
        { label: 'Industrial', color: '#a78bfa', shape: 'swatch' },
        { label: 'Religious', color: '#e879f9', shape: 'swatch' },
        { label: 'Other / Unknown', color: '#94a3b8', shape: 'swatch' },
      ];
    case 'clay':
      return [{ label: 'Architectural Clay', color: '#cbd5e1', shape: 'swatch' }];
    case 'population':
      return [
        { label: 'No residents (est.)', color: '#334155', shape: 'swatch' },
        { label: '1–2 residents', color: '#38bdf8', shape: 'swatch' },
        { label: '3–5', color: '#2dd4bf', shape: 'swatch' },
        { label: '6–11', color: '#f59e0b', shape: 'swatch' },
        { label: '12–29', color: '#f97316', shape: 'swatch' },
        { label: '30+', color: '#ef4444', shape: 'swatch' },
        { label: 'Outside this LGU', color: '#64748b', shape: 'swatch' },
      ];
    case 'height':
    default:
      return [
        { label: '< 6 m (Low-rise)', color: '#38bdf8', shape: 'swatch' },
        { label: '6–12 m', color: '#2dd4bf', shape: 'swatch' },
        { label: '12–24 m', color: '#f59e0b', shape: 'swatch' },
        { label: '24–45 m', color: '#f97316', shape: 'swatch' },
        { label: '45 m+ (High-rise)', color: '#ef4444', shape: 'swatch' },
      ];
  }
}

export const POI_CATEGORY_COLORS: Record<string, string> = {
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

function buildBuildingColorExpression(
  mode: BuildingColorMode,
  theme: 'dark' | 'light' | 'satellite',
  poiCategoryFilter?: string,
  confidenceFilter?: BuildingClassConfidenceFilter
): ExpressionSpecification {
  if (poiCategoryFilter && poiCategoryFilter !== 'all') {
    const matchColor = POI_CATEGORY_COLORS[poiCategoryFilter] ?? '#f59e0b';
    const mutedColor = theme === 'light' ? '#cbd5e1' : '#334155';
    return [
      'case',
      ['boolean', ['feature-state', 'tripOrigin'], false],
      '#22c55e',
      ['boolean', ['feature-state', 'tripDest'], false],
      '#ef4444',
      ['boolean', ['feature-state', 'selected'], false],
      '#fde047',
      ['boolean', ['feature-state', 'hover'], false],
      '#38bdf8',
      ['boolean', ['feature-state', 'catMatch'], false],
      matchColor,
      mutedColor,
    ];
  }

  let baseExpr: ExpressionSpecification;

  if (mode === 'source') {
    baseExpr = [
      'match',
      ['get', 'height_source'],
      'measured',
      '#10b981',
      'floors',
      '#3b82f6',
      'estimated',
      '#f59e0b',
      '#94a3b8',
    ];
  } else if (mode === 'class') {
    baseExpr = [
      'match',
      ['downcase', ['coalesce', ['get', 'bclass'], 'unknown']],
      'residential',
      '#60a5fa',
      'house',
      '#60a5fa',
      'detached',
      '#60a5fa',
      'semidetached_house',
      '#60a5fa',
      'terrace',
      '#60a5fa',
      'bungalow',
      '#60a5fa',
      'apartments',
      '#3b82f6',
      'dormitory',
      '#3b82f6',
      'commercial',
      '#f59e0b',
      'retail',
      '#fb923c',
      'hotel',
      '#fbbf24',
      'resort',
      '#fbbf24',
      'mixed_use',
      '#ec4899',
      'office',
      '#818cf8',
      'civic',
      '#34d399',
      'public',
      '#34d399',
      'government',
      '#34d399',
      'school',
      '#2dd4bf',
      'education',
      '#2dd4bf',
      'college',
      '#2dd4bf',
      'university',
      '#2dd4bf',
      'hospital',
      '#f43f5e',
      'healthcare',
      '#f43f5e',
      'clinic',
      '#f43f5e',
      'industrial',
      '#a78bfa',
      'warehouse',
      '#a78bfa',
      'factory',
      '#a78bfa',
      'manufacture',
      '#a78bfa',
      'religious',
      '#e879f9',
      'church',
      '#e879f9',
      'cathedral',
      '#e879f9',
      'chapel',
      '#e879f9',
      'mosque',
      '#e879f9',
      'temple',
      '#e879f9',
      '#94a3b8',
    ];
  } else if (mode === 'population') {
    // Estimated residents per building, set as feature state 'res' (see TwinViewport) from
    // building_population.bin; -1 = building not in the table.
    baseExpr = [
      'step',
      ['coalesce', ['feature-state', 'res'], -1],
      '#64748b',
      0,
      '#334155',
      0.5,
      '#38bdf8',
      2.5,
      '#2dd4bf',
      5.5,
      '#f59e0b',
      11.5,
      '#f97316',
      29.5,
      '#ef4444',
    ] as unknown as ExpressionSpecification;
  } else if (mode === 'clay') {
    const clayColor = theme === 'dark' ? '#cbd5e1' : '#e2e8f0';
    baseExpr = ['literal', clayColor] as unknown as ExpressionSpecification;
    return [
      'case',
      ['boolean', ['feature-state', 'tripOrigin'], false],
      '#22c55e',
      ['boolean', ['feature-state', 'tripDest'], false],
      '#ef4444',
      ['boolean', ['feature-state', 'selected'], false],
      '#fde047',
      ['boolean', ['feature-state', 'hover'], false],
      '#38bdf8',
      clayColor,
    ];
  } else {
    baseExpr = [
      'interpolate',
      ['linear'],
      ['coalesce', ['get', 'effective_height'], ['get', 'height'], 5],
      4,
      '#38bdf8',
      10,
      '#2dd4bf',
      18,
      '#f59e0b',
      32,
      '#f97316',
      55,
      '#ef4444',
    ];
  }

  return [
    'case',
    ['boolean', ['feature-state', 'tripOrigin'], false],
    '#22c55e',
    ['boolean', ['feature-state', 'tripDest'], false],
    '#ef4444',
    ['boolean', ['feature-state', 'selected'], false],
    '#fde047',
    ['boolean', ['feature-state', 'hover'], false],
    '#38bdf8',
    ...(mode === 'class' && confidenceFilter === 'hide_inferred'
      ? [
          [
            '==',
            ['coalesce', ['get', 'class_confidence'], 'unknown'],
            'inferred',
          ] as unknown as ExpressionSpecification,
          theme === 'light' ? '#cbd5e1' : '#475569',
        ]
      : mode === 'class' && confidenceFilter === 'verified_only'
        ? [
            [
              '!=',
              ['coalesce', ['get', 'class_confidence'], 'unknown'],
              'verified',
            ] as unknown as ExpressionSpecification,
            theme === 'light' ? '#cbd5e1' : '#475569',
          ]
        : []),
    baseExpr,
  ];
}

export const BUILDINGS_SOURCE_ID = 'bacolod-buildings';
export const BUILDINGS_LAYER_ID = 'buildings-3d';
export const BUILDINGS_LABELS_SOURCE_ID = 'bacolod-building-labels';
export const BUILDINGS_LABELS_LAYER_ID = 'buildings-poi-labels';

export const buildingsLayer: TwinLayerDefinition = {
  id: 'buildings',
  name: '3D Buildings',
  description:
    'Overture Maps building footprints classified with OSM places and extruded by measured, floor-derived, or heuristic height.',
  category: 'base',
  engine: 'maplibre',
  defaultVisible: true,
  defaultOpacity: 0.92,
  pickableLayerIds: [BUILDINGS_LAYER_ID, BUILDINGS_LABELS_LAYER_ID],
  legend: getBuildingLegend('class'),
  maplibre(ctx) {
    const {
      map,
      visible,
      opacity,
      buildingColorMode,
      buildingConfidenceFilter,
      theme,
      poiCategoryFilter,
    } = ctx;
    const url = `pmtiles://${getOriginAndBase()}${placePmtiles('buildings')}`;
    const labelsUrl = `${getOriginAndBase()}${placeFile('building_labels.geojson')}`;

    if (!map.getSource(BUILDINGS_SOURCE_ID)) {
      map.addSource(BUILDINGS_SOURCE_ID, {
        type: 'vector',
        url,
        promoteId: 'id',
      });
    }

    if (!map.getSource(BUILDINGS_LABELS_SOURCE_ID)) {
      map.addSource(BUILDINGS_LABELS_SOURCE_ID, {
        type: 'geojson',
        data: labelsUrl,
      });
    }

    const colorExpr = buildBuildingColorExpression(
      buildingColorMode,
      theme,
      poiCategoryFilter,
      buildingConfidenceFilter
    );
    const visibility = visible ? 'visible' : 'none';
    const labelColor = theme === 'light' ? '#0f172a' : '#f8fafc';
    const labelHalo = theme === 'light' ? '#ffffff' : '#090d16';

    if (!map.getLayer(BUILDINGS_LAYER_ID)) {
      map.addLayer({
        id: BUILDINGS_LAYER_ID,
        type: 'fill-extrusion',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': 'buildings',
        minzoom: 11,
        layout: {
          visibility,
        },
        paint: {
          'fill-extrusion-color': colorExpr,
          'fill-extrusion-height': [
            'coalesce',
            ['get', 'effective_height'],
            ['get', 'height'],
            5,
          ],
          'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          'fill-extrusion-opacity': opacity,
          'fill-extrusion-vertical-gradient': true,
        },
      });
    } else {
      map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(BUILDINGS_LAYER_ID, 'fill-extrusion-color', colorExpr);
      map.setPaintProperty(BUILDINGS_LAYER_ID, 'fill-extrusion-opacity', opacity);
    }

    if (!map.getLayer(BUILDINGS_LABELS_LAYER_ID)) {
      map.addLayer({
        id: BUILDINGS_LABELS_LAYER_ID,
        type: 'symbol',
        source: BUILDINGS_LABELS_SOURCE_ID,
        minzoom: 16,
        layout: {
          visibility,
          'text-field': ['get', 'label'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 16, 10.5, 18, 12.5],
          'text-max-width': 11,
          'text-anchor': 'center',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': labelColor,
          'text-halo-color': labelHalo,
          'text-halo-width': 1.6,
          'text-opacity': opacity,
        },
      });
    } else {
      map.setLayoutProperty(BUILDINGS_LABELS_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(BUILDINGS_LABELS_LAYER_ID, 'text-color', labelColor);
      map.setPaintProperty(BUILDINGS_LABELS_LAYER_ID, 'text-halo-color', labelHalo);
      map.setPaintProperty(BUILDINGS_LABELS_LAYER_ID, 'text-opacity', opacity);
    }

    return [BUILDINGS_LAYER_ID, BUILDINGS_LABELS_LAYER_ID];
  },
};
