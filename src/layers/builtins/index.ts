import type { TwinLayerDefinition } from '../types';
import { baseLayer } from './baseLayer';
import { boundariesLayer } from './boundariesLayer';
import { buildingsLayer, getBuildingLegend } from './buildingsLayer';
import { contoursLayer } from './contoursLayer';
import { demReliefLayer } from './demReliefLayer';
import { demSlopeLayer } from './demSlopeLayer';
import { hazardSurgeLayer } from './hazardSurgeLayer';
import { landmarksLayer, placeLandmarks } from './landmarksLayer';
import { mobilityLayer } from './mobilityLayer';
import { poiHeatmapLayer } from './poiHeatmapLayer';
import { roadsLayer } from './roadsLayer';
import { terrainLayer } from './terrainLayer';
import { transitLayer } from './transitLayer';

export const BUILTIN_LAYERS: TwinLayerDefinition[] = [
  baseLayer,
  terrainLayer,
  demReliefLayer,
  demSlopeLayer,
  hazardSurgeLayer,
  contoursLayer,
  roadsLayer,
  transitLayer,
  boundariesLayer,
  poiHeatmapLayer,
  buildingsLayer,
  landmarksLayer,
  mobilityLayer,
];

export {
  placeLandmarks,
  baseLayer,
  boundariesLayer,
  buildingsLayer,
  contoursLayer,
  demReliefLayer,
  demSlopeLayer,
  getBuildingLegend,
  hazardSurgeLayer,
  landmarksLayer,
  mobilityLayer,
  poiHeatmapLayer,
  roadsLayer,
  terrainLayer,
  transitLayer,
};
