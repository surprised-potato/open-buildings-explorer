import type maplibregl from 'maplibre-gl';
import type { TwinLayerDefinition } from '../types';

export const DEM_RELIEF_SOURCE_ID = 'bacolod-dem-relief';
export const DEM_RELIEF_LAYER_ID = 'dem-relief-raster';

const FALLBACK_COORDS: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [122.88, 10.75],
  [123.15, 10.75],
  [123.15, 10.57],
  [122.88, 10.57],
];

function getBase(): string {
  return import.meta.env?.BASE_URL ?? '/';
}

export const demReliefLayer: TwinLayerDefinition = {
  id: 'dem-relief',
  name: 'Elevation Relief (DEM)',
  description:
    'Hypsometric elevation tint from Copernicus GLO-30 highlighting coastal plains and foothills.',
  category: 'environment',
  engine: 'maplibre',
  defaultVisible: false,
  defaultOpacity: 0.58,
  legend: [
    { label: '0–3 m Coastal', color: '#06b6d4', shape: 'swatch' },
    { label: '3–10 m Plain', color: '#10b981', shape: 'swatch' },
    { label: '10–25 m Mid-city', color: '#84cc16', shape: 'swatch' },
    { label: '25–75 m Rise', color: '#eab308', shape: 'swatch' },
    { label: '75–180 m Uplands', color: '#ea580c', shape: 'swatch' },
    { label: '180 m+ Foothills', color: '#b91c1c', shape: 'swatch' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity, demManifest } = ctx;
    const base = getBase();
    const url = `${base}${demManifest?.relief.file ?? 'data/bacolod/dem/bacolod_elevation_relief.png'}`;
    const coordinates = demManifest?.relief.coordinates ?? FALLBACK_COORDS;

    const existingSource = map.getSource(DEM_RELIEF_SOURCE_ID) as
      | maplibregl.ImageSource
      | undefined;
    if (!existingSource) {
      map.addSource(DEM_RELIEF_SOURCE_ID, {
        type: 'image',
        url,
        coordinates,
      });
    } else if (demManifest?.relief.coordinates) {
      existingSource.setCoordinates(demManifest.relief.coordinates);
    }

    const visibility = visible ? 'visible' : 'none';
    const beforeId = map.getLayer('dem-contours-minor')
      ? 'dem-contours-minor'
      : map.getLayer('roads-line')
        ? 'roads-line'
        : map.getLayer('buildings-3d')
          ? 'buildings-3d'
          : undefined;

    if (!map.getLayer(DEM_RELIEF_LAYER_ID)) {
      map.addLayer(
        {
          id: DEM_RELIEF_LAYER_ID,
          type: 'raster',
          source: DEM_RELIEF_SOURCE_ID,
          layout: { visibility },
          paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(DEM_RELIEF_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(DEM_RELIEF_LAYER_ID, 'raster-opacity', opacity);
    }

    return [];
  },
};
