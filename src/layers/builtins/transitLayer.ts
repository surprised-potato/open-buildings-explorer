import type { TwinLayerDefinition } from '../types';
import { placeFile } from '../../utils/place';

export const TRANSIT_SOURCE_ID = 'bacolod-transit';
export const TRANSIT_LINE_ID = 'transit-routes-line';
export const TRANSIT_STOP_ID = 'transit-stops';

const ROUTE_COLORS: Record<string, string> = {
  '1': '#ef4444', '2': '#f97316', '3': '#eab308', '5': '#84cc16', '6': '#22c55e',
  '7': '#14b8a6', '8': '#06b6d4', '9': '#3b82f6', '10': '#8b5cf6', '11': '#d946ef', '16': '#ec4899',
};

/**
 * Bus and modern-jeepney routes and stops mapped in OpenStreetMap (ODbL). These are community-mapped
 * relations, not the official LPTRP, so coverage and accuracy vary.
 */
export const transitLayer: TwinLayerDefinition = {
  id: 'transit',
  name: 'Bus & Jeepney Routes',
  description: 'City bus and jeepney routes and stops from OpenStreetMap (community-mapped, not the official route plan).',
  category: 'infrastructure',
  engine: 'maplibre',
  defaultVisible: false,
  defaultOpacity: 0.9,
  legend: [
    { label: 'Mapped route (colour by route number)', color: '#3b82f6', shape: 'line' },
    { label: 'Bus stop', color: '#f8fafc', shape: 'swatch' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity } = ctx;
    const base = import.meta.env?.BASE_URL ?? '/';
    if (!map.getSource(TRANSIT_SOURCE_ID)) {
      map.addSource(TRANSIT_SOURCE_ID, { type: 'geojson', data: `${base}${placeFile('transit_routes.geojson')}` });
    }
    const visibility = visible ? 'visible' : 'none';
    const match: unknown[] = ['match', ['get', 'ref']];
    for (const [k, v] of Object.entries(ROUTE_COLORS)) match.push(k, v);
    match.push('#94a3b8');

    if (!map.getLayer(TRANSIT_LINE_ID)) {
      map.addLayer({
        id: TRANSIT_LINE_ID,
        type: 'line',
        source: TRANSIT_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'route'],
        layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': match as never,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 4],
          'line-opacity': opacity,
        },
      });
      map.addLayer({
        id: TRANSIT_STOP_ID,
        type: 'circle',
        source: TRANSIT_SOURCE_ID,
        minzoom: 14,
        filter: ['==', ['get', 'kind'], 'stop'],
        layout: { visibility },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 18, 5],
          'circle-color': '#f8fafc',
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1,
          'circle-opacity': opacity,
        },
      });
    } else {
      for (const id of [TRANSIT_LINE_ID, TRANSIT_STOP_ID]) map.setLayoutProperty(id, 'visibility', visibility);
      map.setPaintProperty(TRANSIT_LINE_ID, 'line-opacity', opacity);
      map.setPaintProperty(TRANSIT_STOP_ID, 'circle-opacity', opacity);
    }
    return [];
  },
};
