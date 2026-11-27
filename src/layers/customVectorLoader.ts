import { GeoJsonLayer } from '@deck.gl/layers';
import { PMTiles } from 'pmtiles';
import type {
  CustomVectorStyle,
  LayerCategory,
  TwinLayerDefinition,
} from './types';

export const DEFAULT_CUSTOM_STYLE: CustomVectorStyle = {
  fillColor: '#0ea5e9',
  lineColor: '#38bdf8',
  lineWidth: 2,
  pointRadius: 6,
  extruded: false,
  elevationProperty: null,
  elevationScale: 1,
};

const PREFERRED_ELEVATION_KEYS = [
  'effective_height',
  'height',
  'depth_m',
  'elevation',
  'floors',
  'value',
];

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  if (cleaned.length >= 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  return [14, 165, 233];
}

function makeLayerId(prefix: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${slug || 'layer'}-${suffix}`;
}

function liftCoords(
  coords: unknown,
  sampleElevation: (lon: number, lat: number) => number | null,
  exaggeration: number
): unknown {
  if (!Array.isArray(coords)) return coords;
  if (
    coords.length >= 2 &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number'
  ) {
    const ground = (sampleElevation(coords[0], coords[1]) ?? 0) * exaggeration;
    const baseZ = typeof coords[2] === 'number' ? coords[2] : 0;
    return [coords[0], coords[1], ground + baseZ + 0.8];
  }
  return coords.map((item) => liftCoords(item, sampleElevation, exaggeration));
}

function liftGeometry(
  geometry: GeoJSON.Geometry | null,
  sampleElevation: (lon: number, lat: number) => number | null,
  exaggeration: number
): GeoJSON.Geometry | null {
  if (!geometry) return null;
  if (geometry.type === 'GeometryCollection') {
    return {
      type: 'GeometryCollection',
      geometries: geometry.geometries
        .map((g) => liftGeometry(g, sampleElevation, exaggeration))
        .filter((g): g is GeoJSON.Geometry => g !== null),
    };
  }
  return {
    ...geometry,
    coordinates: liftCoords(
      geometry.coordinates,
      sampleElevation,
      exaggeration
    ) as never,
  };
}

function liftGeoJsonToTerrain(
  geojson: GeoJSON.GeoJSON,
  sampleElevation: (lon: number, lat: number) => number | null,
  exaggeration: number
): GeoJSON.GeoJSON {
  if (geojson.type === 'FeatureCollection') {
    return {
      ...geojson,
      features: geojson.features.map((f) => ({
        ...f,
        geometry: liftGeometry(f.geometry, sampleElevation, exaggeration) as GeoJSON.Geometry,
      })),
    };
  }
  if (geojson.type === 'Feature') {
    return {
      ...geojson,
      geometry: liftGeometry(geojson.geometry, sampleElevation, exaggeration) as GeoJSON.Geometry,
    };
  }
  return liftGeometry(geojson, sampleElevation, exaggeration) as GeoJSON.Geometry;
}

export interface InspectedGeoJsonProperties {
  allProperties: string[];
  numericProperties: string[];
}

/**
 * Inspect a GeoJSON FeatureCollection / Feature to discover all property keys
 * and numeric property keys suitable for elevation or thematic styling.
 */
export function inspectGeoJsonProperties(
  geojson: GeoJSON.GeoJSON | unknown
): InspectedGeoJsonProperties {
  const allSet = new Set<string>();
  const numericSet = new Set<string>();

  if (!geojson || typeof geojson !== 'object') {
    return { allProperties: [], numericProperties: [] };
  }

  const record = geojson as {
    type?: string;
    features?: Array<{ properties?: Record<string, unknown> | null }>;
    properties?: Record<string, unknown> | null;
  };

  const featureList: Array<{ properties?: Record<string, unknown> | null }> =
    record.type === 'FeatureCollection' && Array.isArray(record.features)
      ? record.features
      : record.type === 'Feature'
        ? [record]
        : [];

  for (const feature of featureList) {
    const props = feature?.properties;
    if (!props || typeof props !== 'object') continue;
    for (const [key, value] of Object.entries(props)) {
      allSet.add(key);
      if (typeof value === 'number' && Number.isFinite(value)) {
        numericSet.add(key);
      }
    }
  }

  return {
    allProperties: Array.from(allSet),
    numericProperties: Array.from(numericSet),
  };
}

export interface CreateGeoJsonLayerOptions {
  id?: string;
  name: string;
  description?: string;
  geojson: GeoJSON.GeoJSON;
  sourceUrl?: string;
  category?: LayerCategory;
  defaultStyle?: Partial<CustomVectorStyle>;
}

/**
 * Create an interleaved deck.gl GeoJsonLayer definition supporting fill,
 * line, point radius, and 3D extrusion by a numeric property.
 */
export function createGeoJsonLayerDef(
  options: CreateGeoJsonLayerOptions
): TwinLayerDefinition {
  const { allProperties, numericProperties } = inspectGeoJsonProperties(
    options.geojson
  );

  const preferredElevationProp =
    PREFERRED_ELEVATION_KEYS.find((k) => numericProperties.includes(k)) ??
    numericProperties[0] ??
    null;

  const style: CustomVectorStyle = {
    ...DEFAULT_CUSTOM_STYLE,
    elevationProperty: preferredElevationProp,
    ...options.defaultStyle,
  };

  const layerId = options.id ?? makeLayerId('custom-geojson', options.name);

  return {
    id: layerId,
    name: options.name,
    description:
      options.description ??
      `Custom GeoJSON overlay (${allProperties.length} attributes)`,
    category: options.category ?? 'custom',
    engine: 'deck',
    defaultVisible: true,
    defaultOpacity: 0.82,
    removable: true,
    sourceUrl: options.sourceUrl,
    sourceFormat: 'geojson',
    allProperties,
    numericProperties,
    defaultStyle: style,
    legend: [
      {
        label: options.name,
        color: style.fillColor,
        shape: 'swatch',
      },
    ],
    buildDeckLayer(ctx) {
      if (!ctx.visible) return null;

      const activeStyle = ctx.style ?? style;
      const [fr, fg, fb] = hexToRgb(activeStyle.fillColor);
      const [lr, lg, lb] = hexToRgb(activeStyle.lineColor);
      const fillAlpha = Math.round(Math.max(0, Math.min(1, ctx.opacity)) * 205);
      const lineAlpha = Math.round(Math.max(0, Math.min(1, ctx.opacity)) * 255);
      const elevProp = activeStyle.elevationProperty;
      const elevScale = activeStyle.elevationScale ?? 1;
      const data =
        ctx.terrainEnabled && ctx.sampleElevation
          ? liftGeoJsonToTerrain(
              options.geojson,
              ctx.sampleElevation,
              ctx.terrainExaggeration
            )
          : options.geojson;

      return new GeoJsonLayer({
        id: `${layerId}-deck`,
        data: data as never,
        pickable: true,
        stroked: true,
        filled: true,
        extruded: activeStyle.extruded,
        wireframe: false,
        pointType: 'circle',
        pointRadiusUnits: 'pixels',
        lineWidthUnits: 'pixels',
        getPointRadius: activeStyle.pointRadius,
        getLineWidth: activeStyle.lineWidth,
        getFillColor: [fr, fg, fb, fillAlpha],
        getLineColor: [lr, lg, lb, lineAlpha],
        getElevation: (feature: { properties?: Record<string, unknown> }) => {
          if (!activeStyle.extruded) return 0;
          if (!elevProp) return 10 * elevScale;
          const raw = feature?.properties?.[elevProp];
          const num = typeof raw === 'number' ? raw : Number(raw);
          return Number.isFinite(num) ? Math.max(0, num * elevScale) : 0;
        },
        updateTriggers: {
          getFillColor: [activeStyle.fillColor, ctx.opacity],
          getLineColor: [activeStyle.lineColor, ctx.opacity],
          getLineWidth: [activeStyle.lineWidth],
          getPointRadius: [activeStyle.pointRadius],
          getElevation: [activeStyle.extruded, elevProp, elevScale],
        },
        onClick: (info) => {
          if (!info.object || !ctx.onSelectFeature) return false;
          const featureObj = info.object as {
            id?: string | number;
            properties?: Record<string, unknown>;
          };
          const coord =
            Array.isArray(info.coordinate) && info.coordinate.length >= 2
              ? ([info.coordinate[0], info.coordinate[1]] as [number, number])
              : undefined;
          ctx.onSelectFeature({
            layerId,
            layerName: options.name,
            id: featureObj.id,
            coordinates: coord,
            properties: featureObj.properties ?? {},
          });
          return true;
        },
      });
    },
  };
}

export interface CreateRemotePmtilesOptions {
  id?: string;
  name: string;
  description?: string;
  url: string;
  category?: LayerCategory;
}

interface TileJsonVectorLayer {
  id: string;
  fields?: Record<string, string>;
}

interface PmtilesMetadata {
  vector_layers?: TileJsonVectorLayer[];
}

/**
 * Inspect a remote PMTiles archive via PMTiles.getMetadata(), discover its
 * vector layers & attributes, and create a MapLibre pmtiles:// layer definition.
 */
export async function createRemotePmtilesLayerDef(
  options: CreateRemotePmtilesOptions
): Promise<TwinLayerDefinition> {
  const cleanHttpUrl = options.url.replace(/^pmtiles:\/\//, '').trim();
  const pmtilesUrl = `pmtiles://${cleanHttpUrl}`;

  const archive = new PMTiles(cleanHttpUrl);
  const metadata = (await archive.getMetadata()) as PmtilesMetadata | undefined;
  const vectorLayers = Array.isArray(metadata?.vector_layers)
    ? metadata.vector_layers
    : [];

  if (vectorLayers.length === 0) {
    throw new Error(
      'Remote PMTiles metadata does not declare any vector_layers.'
    );
  }

  const primaryVectorLayer = vectorLayers[0];
  const fields = primaryVectorLayer.fields ?? {};
  const allProperties = Object.keys(fields);
  const numericProperties = allProperties.filter((key) => {
    const type = String(fields[key] ?? '').toLowerCase();
    return type === 'number' || type === 'integer' || type === 'float';
  });

  const preferredElevationProp =
    PREFERRED_ELEVATION_KEYS.find((k) => numericProperties.includes(k)) ??
    numericProperties[0] ??
    null;

  const style: CustomVectorStyle = {
    ...DEFAULT_CUSTOM_STYLE,
    fillColor: '#a855f7',
    lineColor: '#c084fc',
    elevationProperty: preferredElevationProp,
  };

  const layerId = options.id ?? makeLayerId('custom-pmtiles', options.name);
  const sourceId = `${layerId}-src`;
  const fillLayerId = `${layerId}-fill`;
  const extrusionLayerId = `${layerId}-extrusion`;
  const lineLayerId = `${layerId}-line`;
  const circleLayerId = `${layerId}-circle`;
  const sourceLayerName = primaryVectorLayer.id;

  return {
    id: layerId,
    name: options.name,
    description:
      options.description ??
      `Remote PMTiles layer (${sourceLayerName})`,
    category: options.category ?? 'custom',
    engine: 'maplibre',
    defaultVisible: true,
    defaultOpacity: 0.8,
    removable: true,
    sourceUrl: cleanHttpUrl,
    sourceFormat: 'pmtiles',
    allProperties,
    numericProperties,
    defaultStyle: style,
    pickableLayerIds: [fillLayerId, extrusionLayerId, lineLayerId, circleLayerId],
    legend: [
      {
        label: options.name,
        color: style.fillColor,
        shape: 'swatch',
      },
    ],
    maplibre(ctx) {
      const { map, visible, opacity } = ctx;
      const activeStyle = ctx.style ?? style;

      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'vector',
          url: pmtilesUrl,
        });
      }

      const visibility = visible ? 'visible' : 'none';
      const fillVis = visible && !activeStyle.extruded ? 'visible' : 'none';
      const extVis = visible && activeStyle.extruded ? 'visible' : 'none';

      if (!map.getLayer(fillLayerId)) {
        map.addLayer({
          id: fillLayerId,
          type: 'fill',
          source: sourceId,
          'source-layer': sourceLayerName,
          filter: ['==', ['geometry-type'], 'Polygon'],
          layout: { visibility: fillVis },
          paint: {
            'fill-color': activeStyle.fillColor,
            'fill-opacity': opacity * 0.55,
          },
        });
      } else {
        map.setLayoutProperty(fillLayerId, 'visibility', fillVis);
        map.setPaintProperty(fillLayerId, 'fill-color', activeStyle.fillColor);
        map.setPaintProperty(fillLayerId, 'fill-opacity', opacity * 0.55);
      }

      const elevProp = activeStyle.elevationProperty;
      const heightExpr = elevProp
        ? ['*', ['coalesce', ['to-number', ['get', elevProp]], 10], activeStyle.elevationScale]
        : 10 * activeStyle.elevationScale;

      if (!map.getLayer(extrusionLayerId)) {
        map.addLayer({
          id: extrusionLayerId,
          type: 'fill-extrusion',
          source: sourceId,
          'source-layer': sourceLayerName,
          filter: ['==', ['geometry-type'], 'Polygon'],
          layout: { visibility: extVis },
          paint: {
            'fill-extrusion-color': activeStyle.fillColor,
            'fill-extrusion-height': heightExpr as never,
            'fill-extrusion-opacity': opacity * 0.85,
          },
        });
      } else {
        map.setLayoutProperty(extrusionLayerId, 'visibility', extVis);
        map.setPaintProperty(
          extrusionLayerId,
          'fill-extrusion-color',
          activeStyle.fillColor
        );
        map.setPaintProperty(
          extrusionLayerId,
          'fill-extrusion-height',
          heightExpr as never
        );
        map.setPaintProperty(
          extrusionLayerId,
          'fill-extrusion-opacity',
          opacity * 0.85
        );
      }

      if (!map.getLayer(lineLayerId)) {
        map.addLayer({
          id: lineLayerId,
          type: 'line',
          source: sourceId,
          'source-layer': sourceLayerName,
          filter: [
            'any',
            ['==', ['geometry-type'], 'LineString'],
            ['==', ['geometry-type'], 'Polygon'],
          ],
          layout: { visibility },
          paint: {
            'line-color': activeStyle.lineColor,
            'line-width': activeStyle.lineWidth,
            'line-opacity': opacity,
          },
        });
      } else {
        map.setLayoutProperty(lineLayerId, 'visibility', visibility);
        map.setPaintProperty(lineLayerId, 'line-color', activeStyle.lineColor);
        map.setPaintProperty(lineLayerId, 'line-width', activeStyle.lineWidth);
        map.setPaintProperty(lineLayerId, 'line-opacity', opacity);
      }

      if (!map.getLayer(circleLayerId)) {
        map.addLayer({
          id: circleLayerId,
          type: 'circle',
          source: sourceId,
          'source-layer': sourceLayerName,
          filter: ['==', ['geometry-type'], 'Point'],
          layout: { visibility },
          paint: {
            'circle-color': activeStyle.fillColor,
            'circle-radius': activeStyle.pointRadius,
            'circle-stroke-color': activeStyle.lineColor,
            'circle-stroke-width': 1.5,
            'circle-opacity': opacity,
          },
        });
      } else {
        map.setLayoutProperty(circleLayerId, 'visibility', visibility);
        map.setPaintProperty(
          circleLayerId,
          'circle-color',
          activeStyle.fillColor
        );
        map.setPaintProperty(
          circleLayerId,
          'circle-radius',
          activeStyle.pointRadius
        );
        map.setPaintProperty(circleLayerId, 'circle-opacity', opacity);
      }

      return [fillLayerId, extrusionLayerId, lineLayerId, circleLayerId];
    },
  };
}
