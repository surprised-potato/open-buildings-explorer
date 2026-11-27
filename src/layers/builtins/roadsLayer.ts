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

export const ROADS_SOURCE_ID = 'bacolod-roads';
export const ROADS_LAYER_ID = 'roads-line';

export const roadsLayer: TwinLayerDefinition = {
  id: 'roads',
  name: 'Road Network',
  description: 'Bacolod City transportation segments styled by road hierarchy.',
  category: 'infrastructure',
  engine: 'maplibre',
  defaultVisible: true,
  defaultOpacity: 0.85,
  pickableLayerIds: [ROADS_LAYER_ID],
  legend: [
    { label: 'Primary / Trunk', color: '#f59e0b', shape: 'line' },
    { label: 'Secondary / Tertiary', color: '#38bdf8', shape: 'line' },
    { label: 'Local / Residential', color: '#94a3b8', shape: 'line' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity, theme } = ctx;
    const url = `pmtiles://${getOriginAndBase()}${placePmtiles('roads')}`;

    if (!map.getSource(ROADS_SOURCE_ID)) {
      map.addSource(ROADS_SOURCE_ID, {
        type: 'vector',
        url,
      });
    }

    const localRoadColor = theme === 'light' ? '#64748b' : '#94a3b8';
    const visibility = visible ? 'visible' : 'none';
    const beforeId = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;

    if (!map.getLayer(ROADS_LAYER_ID)) {
      map.addLayer(
        {
          id: ROADS_LAYER_ID,
          type: 'line',
          source: ROADS_SOURCE_ID,
          'source-layer': 'roads',
          minzoom: 10,
          layout: {
            visibility,
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': [
              'match',
              ['downcase', ['coalesce', ['get', 'rclass'], 'unknown']],
              'motorway',
              '#ef4444',
              'trunk',
              '#f97316',
              'primary',
              '#f59e0b',
              'secondary',
              '#38bdf8',
              'tertiary',
              '#22d3ee',
              localRoadColor,
            ],
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              [
                'match',
                ['downcase', ['coalesce', ['get', 'rclass'], 'unknown']],
                ['motorway', 'trunk', 'primary'],
                2.2,
                ['secondary', 'tertiary'],
                1.4,
                0.6,
              ],
              16,
              [
                'match',
                ['downcase', ['coalesce', ['get', 'rclass'], 'unknown']],
                ['motorway', 'trunk', 'primary'],
                6.5,
                ['secondary', 'tertiary'],
                4.2,
                2.0,
              ],
            ],
            'line-opacity': opacity,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(ROADS_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(ROADS_LAYER_ID, 'line-opacity', opacity);
    }

    return [ROADS_LAYER_ID];
  },
};
