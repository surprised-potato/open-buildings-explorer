import type { TwinLayerDefinition } from '../types';
import { placePmtiles } from '../../utils/place';

function getOriginAndBase(): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${origin}${base}`;
}

export const BASE_SOURCE_ID = 'bacolod-base';
export const BASE_LAND_LAYER_ID = 'base-land-use';
export const BASE_WATER_LAYER_ID = 'base-water';

export const baseLayer: TwinLayerDefinition = {
  id: 'base',
  name: 'Water & Land Use',
  description:
    'Guimaras Strait coastline, creeks, parks, and urban land-use polygons.',
  category: 'base',
  engine: 'maplibre',
  defaultVisible: true,
  defaultOpacity: 0.72,
  legend: [
    { label: 'Waterways / Coast', color: '#0284c7', shape: 'swatch' },
    { label: 'Parks & Vegetation', color: '#16a34a', shape: 'swatch' },
    { label: 'Urban Land Use', color: '#64748b', shape: 'swatch' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity, theme } = ctx;
    const url = `pmtiles://${getOriginAndBase()}${placePmtiles('base')}`;

    if (!map.getSource(BASE_SOURCE_ID)) {
      map.addSource(BASE_SOURCE_ID, {
        type: 'vector',
        url,
      });
    }

    const visibility = visible ? 'visible' : 'none';
    const beforeId = map.getLayer('roads-line')
      ? 'roads-line'
      : map.getLayer('buildings-3d')
        ? 'buildings-3d'
        : undefined;

    const waterColor = theme === 'light' ? '#38bdf8' : '#0369a1';
    const parkColor = theme === 'light' ? '#86efac' : '#15803d';
    const urbanColor = theme === 'light' ? '#cbd5e1' : '#334155';

    if (!map.getLayer(BASE_LAND_LAYER_ID)) {
      map.addLayer(
        {
          id: BASE_LAND_LAYER_ID,
          type: 'fill',
          source: BASE_SOURCE_ID,
          'source-layer': 'base',
          filter: ['==', ['get', 'kind'], 'land_use'],
          minzoom: 10,
          layout: { visibility },
          paint: {
            'fill-color': [
              'match',
              ['downcase', ['coalesce', ['get', 'bclass'], 'other']],
              ['park', 'forest', 'grass', 'recreation_ground', 'meadow', 'farmland'],
              parkColor,
              urbanColor,
            ],
            'fill-opacity': opacity * 0.45,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(BASE_LAND_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(BASE_LAND_LAYER_ID, 'fill-opacity', opacity * 0.45);
    }

    if (!map.getLayer(BASE_WATER_LAYER_ID)) {
      map.addLayer(
        {
          id: BASE_WATER_LAYER_ID,
          type: 'fill',
          source: BASE_SOURCE_ID,
          'source-layer': 'base',
          filter: ['==', ['get', 'kind'], 'water'],
          minzoom: 10,
          layout: { visibility },
          paint: {
            'fill-color': waterColor,
            'fill-opacity': opacity * 0.7,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(BASE_WATER_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(BASE_WATER_LAYER_ID, 'fill-color', waterColor);
      map.setPaintProperty(BASE_WATER_LAYER_ID, 'fill-opacity', opacity * 0.7);
    }

    return [BASE_LAND_LAYER_ID, BASE_WATER_LAYER_ID];
  },
};
