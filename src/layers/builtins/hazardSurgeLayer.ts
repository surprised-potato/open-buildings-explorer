import type { TwinLayerDefinition } from '../types';

export const HAZARD_SURGE_SOURCE_ID = 'bacolod-hazard-surge';
export const HAZARD_SURGE_FILL_ID = 'hazard-surge-fill';
export const HAZARD_SURGE_LINE_ID = 'hazard-surge-line';

/**
 * Project NOAH storm surge advisories (ODbL, UP Resilience Institute). Each advisory polygon is the area
 * reached at that surge height and they are nested, so translucent fills stack: deeper blue means reached
 * by a smaller, more likely surge.
 */
export const hazardSurgeLayer: TwinLayerDefinition = {
  id: 'hazard-surge',
  name: 'Storm Surge Hazard',
  description:
    'Areas reached by modelled storm surge of 2-3 m up to over 5 m (Project NOAH, ODbL). Modelled hazard, not a forecast.',
  category: 'environment',
  engine: 'maplibre',
  defaultVisible: false,
  defaultOpacity: 0.55,
  legend: [
    { label: 'Reached by 2-3 m surge', color: '#1d4ed8', shape: 'swatch' },
    { label: 'Reached by 3-4 m', color: '#3b82f6', shape: 'swatch' },
    { label: 'Reached by 4-5 m', color: '#60a5fa', shape: 'swatch' },
    { label: 'Reached by over 5 m', color: '#bfdbfe', shape: 'swatch' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity } = ctx;
    const base = import.meta.env?.BASE_URL ?? '/';
    if (!map.getSource(HAZARD_SURGE_SOURCE_ID)) {
      map.addSource(HAZARD_SURGE_SOURCE_ID, {
        type: 'geojson',
        data: `${base}data/bacolod/hazards.geojson`,
      });
    }
    const visibility = visible ? 'visible' : 'none';
    const beforeId = map.getLayer('roads-line')
      ? 'roads-line'
      : map.getLayer('buildings-3d')
        ? 'buildings-3d'
        : undefined;

    if (!map.getLayer(HAZARD_SURGE_FILL_ID)) {
      map.addLayer(
        {
          id: HAZARD_SURGE_FILL_ID,
          type: 'fill',
          source: HAZARD_SURGE_SOURCE_ID,
          filter: ['in', ['get', 'hazard'], ['literal', ['surge_ssa1', 'surge_ssa2', 'surge_ssa3', 'surge_ssa4']]],
          layout: { visibility },
          paint: {
            'fill-color': [
              'match',
              ['get', 'hazard'],
              'surge_ssa1', '#1d4ed8',
              'surge_ssa2', '#3b82f6',
              'surge_ssa3', '#60a5fa',
              '#93c5fd',
            ],
            'fill-opacity': opacity * 0.45,
          },
        },
        beforeId
      );
      map.addLayer(
        {
          id: HAZARD_SURGE_LINE_ID,
          type: 'line',
          source: HAZARD_SURGE_SOURCE_ID,
          filter: ['==', ['get', 'hazard'], 'surge_ssa4'],
          layout: { visibility },
          paint: { 'line-color': '#60a5fa', 'line-width': 1, 'line-opacity': opacity },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(HAZARD_SURGE_FILL_ID, 'visibility', visibility);
      map.setLayoutProperty(HAZARD_SURGE_LINE_ID, 'visibility', visibility);
      map.setPaintProperty(HAZARD_SURGE_FILL_ID, 'fill-opacity', opacity * 0.45);
      map.setPaintProperty(HAZARD_SURGE_LINE_ID, 'line-opacity', opacity);
    }
    return [];
  },
};
