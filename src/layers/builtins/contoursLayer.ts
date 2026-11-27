import type { TwinLayerDefinition } from '../types';

function getOriginAndBase(): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${origin}${base}`;
}

export const CONTOURS_SOURCE_ID = 'bacolod-contours';
export const CONTOURS_MINOR_LAYER_ID = 'dem-contours-minor';
export const CONTOURS_MAJOR_LAYER_ID = 'dem-contours-major';
export const CONTOURS_LABEL_LAYER_ID = 'dem-contours-label';

export const contoursLayer: TwinLayerDefinition = {
  id: 'dem-contours',
  name: 'Elevation Contours (5m / 25m)',
  description:
    'Topographic contour lines derived from Copernicus GLO-30 DEM with 25m index labels.',
  category: 'environment',
  engine: 'maplibre',
  defaultVisible: true,
  defaultOpacity: 0.72,
  legend: [
    { label: '5 m Contour', color: '#2dd4bf', shape: 'line' },
    { label: '25 m Index Contour', color: '#f59e0b', shape: 'line' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity, theme } = ctx;
    const url = `pmtiles://${getOriginAndBase()}data/bacolod/dem/bacolod_contours.pmtiles`;

    if (!map.getSource(CONTOURS_SOURCE_ID)) {
      map.addSource(CONTOURS_SOURCE_ID, {
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

    const minorColor = theme === 'light' ? '#0f766e' : '#2dd4bf';
    const majorColor = theme === 'light' ? '#b45309' : '#f59e0b';
    const labelColor = theme === 'light' ? '#78350f' : '#fde68a';
    const haloColor = theme === 'light' ? '#f8fafc' : '#090d16';

    if (!map.getLayer(CONTOURS_MINOR_LAYER_ID)) {
      map.addLayer(
        {
          id: CONTOURS_MINOR_LAYER_ID,
          type: 'line',
          source: CONTOURS_SOURCE_ID,
          'source-layer': 'contours',
          filter: ['==', ['get', 'is_major'], 0],
          minzoom: 12.5,
          layout: { visibility },
          paint: {
            'line-color': minorColor,
            'line-width': ['interpolate', ['linear'], ['zoom'], 12.5, 0.5, 16, 1.1],
            'line-opacity': opacity * 0.48,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(CONTOURS_MINOR_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(CONTOURS_MINOR_LAYER_ID, 'line-color', minorColor);
      map.setPaintProperty(
        CONTOURS_MINOR_LAYER_ID,
        'line-opacity',
        opacity * 0.48
      );
    }

    if (!map.getLayer(CONTOURS_MAJOR_LAYER_ID)) {
      map.addLayer(
        {
          id: CONTOURS_MAJOR_LAYER_ID,
          type: 'line',
          source: CONTOURS_SOURCE_ID,
          'source-layer': 'contours',
          filter: ['==', ['get', 'is_major'], 1],
          minzoom: 11,
          layout: { visibility },
          paint: {
            'line-color': majorColor,
            'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.9, 16, 1.9],
            'line-opacity': opacity * 0.85,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(CONTOURS_MAJOR_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(CONTOURS_MAJOR_LAYER_ID, 'line-color', majorColor);
      map.setPaintProperty(
        CONTOURS_MAJOR_LAYER_ID,
        'line-opacity',
        opacity * 0.85
      );
    }

    if (!map.getLayer(CONTOURS_LABEL_LAYER_ID)) {
      map.addLayer(
        {
          id: CONTOURS_LABEL_LAYER_ID,
          type: 'symbol',
          source: CONTOURS_SOURCE_ID,
          'source-layer': 'contours',
          filter: ['==', ['get', 'is_major'], 1],
          minzoom: 12,
          layout: {
            visibility,
            'symbol-placement': 'line',
            'text-field': ['get', 'label'],
            'text-size': 10.5,
            'text-max-angle': 30,
          },
          paint: {
            'text-color': labelColor,
            'text-halo-color': haloColor,
            'text-halo-width': 1.5,
            'text-opacity': opacity,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(CONTOURS_LABEL_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(CONTOURS_LABEL_LAYER_ID, 'text-color', labelColor);
      map.setPaintProperty(CONTOURS_LABEL_LAYER_ID, 'text-halo-color', haloColor);
      map.setPaintProperty(CONTOURS_LABEL_LAYER_ID, 'text-opacity', opacity);
    }

    return [];
  },
};
