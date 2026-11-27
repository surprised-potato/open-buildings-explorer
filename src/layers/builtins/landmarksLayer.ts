import { ColumnLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { getPlaceMeta } from '../../utils/place';
import type { LandmarkItem, TwinLayerDefinition } from '../types';

/** Landmarks of the current place (overrides/<place>/place.json via place.json). */
export function placeLandmarks(): LandmarkItem[] {
  return getPlaceMeta().landmarks;
}

export const landmarksLayer: TwinLayerDefinition = {
  id: 'landmarks',
  name: 'Civic Landmarks',
  description:
    '8 key Bacolod City civic, heritage, education, and waterfront anchors.',
  category: 'civic',
  engine: 'deck',
  defaultVisible: true,
  defaultOpacity: 1,
  legend: [
    { label: 'Civic & Heritage Anchor', color: '#f59e0b', shape: 'circle' },
  ],
  buildDeckLayer(ctx) {
    if (!ctx.visible) return null;

    const alpha = Math.round(Math.max(0, Math.min(1, ctx.opacity)) * 255);
    const selectedId =
      ctx.selectedFeature?.layerId === 'landmarks'
        ? ctx.selectedFeature.id
        : null;

    const handlePick = (info: { object?: LandmarkItem }) => {
      if (!info.object || !ctx.onSelectFeature) return false;
      const item = info.object;
      ctx.onSelectFeature({
        layerId: 'landmarks',
        layerName: 'Civic Landmarks',
        id: item.id,
        coordinates: item.coordinates,
        properties: {
          id: item.id,
          name: item.name,
          category: item.category,
          description: item.description,
          longitude: item.coordinates[0],
          latitude: item.coordinates[1],
        },
      });
      return true;
    };

    const groundZ = (d: LandmarkItem): number => {
      if (!ctx.terrainEnabled || !ctx.sampleElevation) return 0;
      const e = ctx.sampleElevation(d.coordinates[0], d.coordinates[1]);
      return e !== null ? e * ctx.terrainExaggeration : 0;
    };

    const haloLayer = new ScatterplotLayer<LandmarkItem>({
      id: 'landmarks-halo',
      data: placeLandmarks(),
      pickable: true,
      radiusUnits: 'meters',
      getPosition: (d) => [d.coordinates[0], d.coordinates[1], groundZ(d) + 1.5],
      getRadius: (d) => (d.id === selectedId ? 28 : 18),
      getFillColor: (d) =>
        d.id === selectedId
          ? [253, 224, 71, Math.round(alpha * 0.45)]
          : [245, 158, 11, Math.round(alpha * 0.25)],
      getLineColor: [245, 158, 11, alpha],
      lineWidthMinPixels: 1.5,
      stroked: true,
      updateTriggers: {
        getPosition: [ctx.terrainEnabled, ctx.terrainExaggeration],
        getRadius: [selectedId],
        getFillColor: [selectedId, alpha],
      },
      onClick: handlePick,
    });

    const columnLayer = new ColumnLayer<LandmarkItem>({
      id: 'landmarks-beacon',
      data: placeLandmarks(),
      pickable: true,
      diskResolution: 12,
      radius: 5,
      extruded: true,
      getPosition: (d) => [d.coordinates[0], d.coordinates[1], groundZ(d)],
      getElevation: (d) => (d.id === selectedId ? 68 : 48),
      getFillColor: (d) =>
        d.id === selectedId
          ? [253, 224, 71, alpha]
          : [245, 158, 11, Math.round(alpha * 0.9)],
      updateTriggers: {
        getPosition: [ctx.terrainEnabled, ctx.terrainExaggeration],
        getElevation: [selectedId],
        getFillColor: [selectedId, alpha],
      },
      onClick: handlePick,
    });

    const textLayer = new TextLayer<LandmarkItem>({
      id: 'landmarks-labels',
      data: placeLandmarks(),
      pickable: true,
      characterSet: 'auto',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: 600,
      getPosition: (d) => [d.coordinates[0], d.coordinates[1], groundZ(d) + 62],
      getText: (d) => d.name,
      getSize: 13,
      sizeUnits: 'pixels',
      getPixelOffset: [0, -14],
      getColor:
        ctx.theme === 'light'
          ? [15, 23, 42, alpha]
          : [248, 250, 252, alpha],
      background: true,
      getBackgroundColor:
        ctx.theme === 'light'
          ? [255, 255, 255, Math.round(alpha * 0.85)]
          : [15, 23, 42, Math.round(alpha * 0.82)],
      backgroundPadding: [6, 3],
      updateTriggers: {
        getPosition: [ctx.terrainEnabled, ctx.terrainExaggeration],
        getColor: [ctx.theme, alpha],
        getBackgroundColor: [ctx.theme, alpha],
      },
      onClick: handlePick,
    });

    return [haloLayer, columnLayer, textLayer];
  },
};
