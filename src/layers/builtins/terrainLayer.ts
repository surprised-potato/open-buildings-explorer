import type { TwinLayerDefinition } from '../types';
import { placeFile } from '../../utils/place';

function getOriginAndBase(): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${origin}${base}`;
}

export const TERRAIN_SOURCE_ID = 'bacolod-copernicus-dem';
export const TERRAIN_HILLSHADE_LAYER_ID = 'terrain-hillshade';

export const terrainLayer: TwinLayerDefinition = {
  id: 'terrain',
  name: '3D Terrain (Copernicus 30m DEM)',
  description:
    'Local Copernicus GLO-30 elevation mesh with hillshade relief and vertical exaggeration.',
  category: 'environment',
  engine: 'maplibre',
  defaultVisible: true,
  defaultOpacity: 0.45,
  maplibre(ctx) {
    const {
      map,
      visible,
      opacity,
      terrainEnabled,
      terrainExaggeration,
      theme,
      demManifest,
    } = ctx;

    const template =
      demManifest?.terrarium.tiles_template ??
      placeFile('dem/terrarium/{z}/{x}/{y}.png');
    const tileUrl = `${getOriginAndBase()}${template}`;

    if (!map.getSource(TERRAIN_SOURCE_ID)) {
      map.addSource(TERRAIN_SOURCE_ID, {
        type: 'raster-dem',
        tiles: [tileUrl],
        encoding: 'terrarium',
        tileSize: 256,
        minzoom: demManifest?.terrarium.minzoom ?? 10,
        maxzoom: demManifest?.terrarium.maxzoom ?? 13,
        bounds: demManifest?.terrarium.bounds ?? [122.85, 10.54, 123.2, 10.78],
      });
    }

    const active = terrainEnabled || visible;
    const visibility = active ? 'visible' : 'none';
    const beforeId = map.getLayer('dem-relief-raster')
      ? 'dem-relief-raster'
      : map.getLayer('dem-slope-raster')
        ? 'dem-slope-raster'
        : map.getLayer('dem-contours-minor')
          ? 'dem-contours-minor'
          : map.getLayer('base-land-use')
            ? 'base-land-use'
            : map.getLayer('roads-line')
              ? 'roads-line'
              : map.getLayer('buildings-3d')
                ? 'buildings-3d'
                : undefined;

    if (!map.getLayer(TERRAIN_HILLSHADE_LAYER_ID)) {
      map.addLayer(
        {
          id: TERRAIN_HILLSHADE_LAYER_ID,
          type: 'hillshade',
          source: TERRAIN_SOURCE_ID,
          layout: { visibility },
          paint: {
            'hillshade-exaggeration': Math.min(1, Math.max(0.1, opacity)),
            'hillshade-shadow-color':
              theme === 'light' ? '#334155' : '#020617',
            'hillshade-highlight-color':
              theme === 'light' ? '#ffffff' : '#64748b',
          },
        },
        beforeId
      );
    } else {
      map.setLayoutProperty(TERRAIN_HILLSHADE_LAYER_ID, 'visibility', visibility);
      map.setPaintProperty(
        TERRAIN_HILLSHADE_LAYER_ID,
        'hillshade-exaggeration',
        Math.min(1, Math.max(0.1, opacity))
      );
    }

    if (active && terrainExaggeration > 0) {
      map.setTerrain({
        source: TERRAIN_SOURCE_ID,
        exaggeration: terrainExaggeration,
      });
    } else {
      map.setTerrain(null);
    }

    return [];
  },
};
