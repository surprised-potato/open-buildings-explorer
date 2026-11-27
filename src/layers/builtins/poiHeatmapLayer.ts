import type maplibregl from 'maplibre-gl';
import type { BuildingPoiRecord, TwinLayerDefinition } from '../types';

export const POI_HEATMAP_SOURCE_ID = 'bacolod-poi-heatmap';
export const POI_HEATMAP_LAYER_ID = 'poi-density-heatmap';

const lastDataKeyByMap = new WeakMap<maplibregl.Map, string>();

function buildHeatmapGeoJson(
  buildingPois: Record<string, BuildingPoiRecord> | undefined,
  categoryFilter: string
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  if (!buildingPois) {
    return { type: 'FeatureCollection', features };
  }

  for (const rec of Object.values(buildingPois)) {
    if (!Array.isArray(rec.center) || rec.center.length < 2) continue;
    let weight = 0;
    if (categoryFilter === 'all') {
      weight = rec.poi_count || rec.pois?.length || 1;
    } else {
      for (const poi of rec.pois ?? []) {
        if (poi.category === categoryFilter) {
          weight += 1;
        }
      }
    }
    if (weight <= 0) continue;

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: rec.center,
      },
      properties: {
        weight: Math.min(20, weight),
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

export const poiHeatmapLayer: TwinLayerDefinition = {
  id: 'poi-heatmap',
  name: 'POI Density Heatmap',
  description:
    'WebGL thermal density map of linked commercial, food, retail, and civic places.',
  category: 'civic',
  engine: 'maplibre',
  defaultVisible: false,
  defaultOpacity: 0.85,
  legend: [
    { label: 'Low POI Density', color: '#38bdf8', shape: 'circle' },
    { label: 'Moderate Hub', color: '#f59e0b', shape: 'circle' },
    { label: 'High Commercial Core', color: '#ef4444', shape: 'circle' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity, buildingPois, poiCategoryFilter } = ctx;
    const activeFilter = poiCategoryFilter ?? 'all';
    const recordCount = buildingPois ? Object.keys(buildingPois).length : 0;
    const dataKey = `${activeFilter}:${recordCount}`;

    const existingSource = map.getSource(POI_HEATMAP_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;

    if (!existingSource) {
      map.addSource(POI_HEATMAP_SOURCE_ID, {
        type: 'geojson',
        data: buildHeatmapGeoJson(buildingPois, activeFilter),
      });
      lastDataKeyByMap.set(map, dataKey);
    } else if (lastDataKeyByMap.get(map) !== dataKey) {
      existingSource.setData(buildHeatmapGeoJson(buildingPois, activeFilter));
      lastDataKeyByMap.set(map, dataKey);
    }

    const visibility = visible ? 'visible' : 'none';
    const beforeId = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined;

    if (!map.getLayer(POI_HEATMAP_LAYER_ID)) {
      map.addLayer(
        {
          id: POI_HEATMAP_LAYER_ID,
          type: 'heatmap',
          source: POI_HEATMAP_SOURCE_ID,
          maxzoom: 19,
          layout: { visibility },
          paint: {
            'heatmap-weight': [
              'interpolate',
              ['linear'],
              ['coalesce', ['get', 'weight'], 1],
              1,
              0.35,
              5,
              0.8,
              15,
              1.0,
            ],
            'heatmap-intensity': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              0.8,
              15,
              1.6,
              18,
              2.2,
            ],
            'heatmap-color': [
              'interpolate',
              ['linear'],
              ['heatmap-density'],
              0,
              'rgba(0, 0, 0, 0)',
              0.18,
              'rgba(56, 189, 248, 0.55)',
              0.42,
              'rgba(45, 212, 191, 0.72)',
              0.68,
              'rgba(245, 158, 11, 0.86)',
              0.9,
              'rgba(239, 68, 68, 0.94)',
            ],
            'heatmap-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              14,
              13,
              24,
              16,
              38,
              18,
              50,
            ],
            'heatmap-opacity': opacity,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(POI_HEATMAP_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(POI_HEATMAP_LAYER_ID, 'heatmap-opacity', opacity);
    }

    return [];
  },
};
