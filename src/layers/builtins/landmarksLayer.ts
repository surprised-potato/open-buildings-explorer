import { ColumnLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LandmarkItem, TwinLayerDefinition } from '../types';

export const BACOLOD_LANDMARKS: LandmarkItem[] = [
  {
    id: 'public-plaza',
    name: 'Bacolod Public Plaza',
    category: 'Civic Heritage',
    description:
      'Historic heart of Bacolod City with central bandstand and civic promenade.',
    coordinates: [122.94642, 10.66937],
    camera: { center: [122.94642, 10.66937], zoom: 16.4, pitch: 58, bearing: -20 },
  },
  {
    id: 'san-sebastian-cathedral',
    name: 'San Sebastian Cathedral',
    category: 'Heritage',
    description:
      '19th-century coral-stone cathedral facing the Bacolod Public Plaza.',
    coordinates: [122.94715, 10.67033],
    camera: { center: [122.94715, 10.67033], zoom: 17.0, pitch: 60, bearing: 25 },
  },
  {
    id: 'new-government-center',
    name: 'Bacolod New Government Center',
    category: 'Government',
    description:
      'Bacolod City Hall and civic grounds along Circumferential Road.',
    coordinates: [122.96658, 10.65885],
    camera: { center: [122.96658, 10.65885], zoom: 16.2, pitch: 56, bearing: -35 },
  },
  {
    id: 'capitol-lagoon',
    name: 'Capitol Park and Lagoon',
    category: 'Civic Park',
    description:
      'Negros Occidental Provincial Capitol complex and twin-sculpture lagoon.',
    coordinates: [122.9521, 10.67604],
    camera: { center: [122.9521, 10.67604], zoom: 16.3, pitch: 55, bearing: -12 },
  },
  {
    id: 'bredco-port',
    name: 'BREDCO Port & Reclamation',
    category: 'Maritime & Mixed-Use',
    description:
      'Major ferry terminal, commercial reclamation zone, and SM City Bacolod waterfront.',
    coordinates: [122.94479, 10.68261],
    camera: { center: [122.94479, 10.68261], zoom: 15.2, pitch: 54, bearing: 40 },
  },
  {
    id: 'the-ruins',
    name: 'The Ruins (North Border)',
    category: 'Heritage',
    description:
      'Iconic ancestral mansion ruins just north of the Bacolod–Talisay boundary.',
    coordinates: [122.98266, 10.70921],
    camera: { center: [122.98266, 10.70921], zoom: 16.4, pitch: 58, bearing: -15 },
  },
  {
    id: 'usls-bacolod',
    name: 'University of St. La Salle',
    category: 'Education',
    description:
      'Major academic campus anchoring the La Salle–Villamonte corridor.',
    coordinates: [122.96248, 10.67842],
    camera: { center: [122.96248, 10.67842], zoom: 16.0, pitch: 52, bearing: -25 },
  },
  {
    id: 'panaad-stadium',
    name: 'Panaad Park and Stadium',
    category: 'Sports & Recreation',
    description:
      '20,000-seat provincial sports complex and forested park in Barangay Mansilingan.',
    coordinates: [122.96461, 10.62378],
    camera: { center: [122.96461, 10.62378], zoom: 15.8, pitch: 54, bearing: 18 },
  },
];

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
      data: BACOLOD_LANDMARKS,
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
      data: BACOLOD_LANDMARKS,
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
      data: BACOLOD_LANDMARKS,
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
