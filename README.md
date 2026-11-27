# Bacolod City 3D Digital Twin

Interactive 3D map, analytics, agent-based mobility simulation and reports for Bacolod City (React, MapLibre GL, deck.gl, PMTiles).

Live: https://surprised-potato.github.io/open-buildings-explorer/

```bash
npm ci && npm run dev      # app
npm test                   # tests
```

Data pipeline and every layer's source, licence and rebuild command: see [datalayers.md](datalayers.md).

## Data attribution
- © OpenStreetMap contributors (ODbL), Overture Maps Foundation buildings and places (ODbL / CDLA), Project NOAH storm surge hazard maps, University of the Philippines (ODbL).
- Philippine Statistics Authority 2020 census (CC BY, via HDX); WorldPop 100 m population grid (CC BY 4.0); ESA WorldCover 2021 (CC BY 4.0).
- Derived estimates (zonal values, trip purposes, trip generation, hazard exposure) rest on stated assumptions; they are not official figures.
- Satellite basemaps (Esri, Google) are loaded from their own services; Google needs your own API key.
