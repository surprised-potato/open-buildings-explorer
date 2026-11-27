import type maplibregl from 'maplibre-gl';
import type { TwinLayerDefinition } from '../types';
import { getPlaceMeta, placeFile } from '../../utils/place';

export const DEM_SLOPE_SOURCE_ID = 'bacolod-dem-slope';
export const DEM_SLOPE_LAYER_ID = 'dem-slope-raster';

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

export const demSlopeLayer: TwinLayerDefinition = {
  id: 'dem-slope',
  name: 'Terrain Slope',
  description:
    'Terrain steepness in degrees (computed in UTM 51N) distinguishing flat basins from ridges.',
  category: 'environment',
  engine: 'maplibre',
  defaultVisible: false,
  defaultOpacity: 0.6,
  legend: [
    { label: '1–3° Gentle', color: '#38bdf8', shape: 'swatch' },
    { label: '3–8° Moderate', color: '#facc15', shape: 'swatch' },
    { label: '8–15° Steep', color: '#f97316', shape: 'swatch' },
    { label: '15°+ Escarpment', color: '#e11d48', shape: 'swatch' },
  ],
  maplibre(ctx) {
    const { map, visible, opacity, demManifest } = ctx;
    const base = getBase();
    const url = `${base}${demManifest?.slope.file ?? placeFile(`dem/${getPlaceMeta().filePrefix}_slope.png`)}`;
    const coordinates = demManifest?.slope.coordinates ?? FALLBACK_COORDS;

    const existingSource = map.getSource(DEM_SLOPE_SOURCE_ID) as
      | maplibregl.ImageSource
      | undefined;
    if (!existingSource) {
      map.addSource(DEM_SLOPE_SOURCE_ID, {
        type: 'image',
        url,
        coordinates,
      });
    } else if (demManifest?.slope.coordinates) {
      existingSource.setCoordinates(demManifest.slope.coordinates);
    }

    const visibility = visible ? 'visible' : 'none';
    const beforeId = map.getLayer('dem-contours-minor')
      ? 'dem-contours-minor'
      : map.getLayer('roads-line')
        ? 'roads-line'
        : map.getLayer('buildings-3d')
          ? 'buildings-3d'
          : undefined;

    if (!map.getLayer(DEM_SLOPE_LAYER_ID)) {
      map.addLayer(
        {
          id: DEM_SLOPE_LAYER_ID,
          type: 'raster',
          source: DEM_SLOPE_SOURCE_ID,
          layout: { visibility },
          paint: {
            'raster-opacity': opacity,
            'raster-fade-duration': 0,
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(DEM_SLOPE_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(DEM_SLOPE_LAYER_ID, 'raster-opacity', opacity);
    }

    return [];
  },
};
