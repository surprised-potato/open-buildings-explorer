# Handoff: Bacolod City 3D Digital Twin → Claude Opus 5.5

Generated 2026-11-27. Workspace: `/home/daniel/Documents/Open Buildings Explorer` (not a git repo; no VCS safety net, so make backups before big refactors).

## 0. First 5 minutes

```bash
cd "/home/daniel/Documents/Open Buildings Explorer"
npm test && npm run build                      # expect 9 files / 47 tests pass, tsc + vite exit 0
uv run python -m unittest scripts/test_export_trafficsim_network.py scripts/test_enrich_osm_buildings.py scripts/test_compute_barangay_analytics.py -v   # 16 tests OK
npm run dev                                    # then open the Vite URL
```

Note: the user's global memory mentions a `run_tests.txt`; it does **not** exist in this repo. Use the commands above.

## 1. Stack

React 18 + TypeScript + Vite 6, MapLibre GL v5, deck.gl v9 (`MapLibreOverlay`, interleaved), PMTiles. Python 3.12 via `uv` (GDAL/ogr2ogr, DuckDB, Shapely 2.x, numpy, scipy). Layers are registered through `src/layers/registry.ts` (`TwinStoreProvider` / `useTwinStore`, prefs in localStorage key `bacolod_twin_prefs_v2`).

## 2. What has been built (all verified)

1. **POI enrichment + building classification**: OSM + Overture Places (2026-11-18.0, confidence ≥ 0.65, includes embedded Foursquare) deduplicated, matched to nearest building, buildings reclassified (`mixed_use` added). POIs shown as collapsible cards in the building inspector (`building_pois.json`), z16+ name labels. `scripts/enrich_osm_buildings.py`.
2. **Urban analytics**: barangay dashboard + 6-metric choropleth, 250 m catchment site-selection scorer, category filter, POI heatmap, terrain elevation profile on Measure tool. `scripts/compute_barangay_analytics.py`, `src/utils/siteSelection.ts`, `elevationProfile.ts`, `AnalyticsPanel.tsx`.
3. **Barangay selection/highlight**: shared `selectedBarangayName` in store; click map / analytics list / top-bar search; glow+fill+line+label sub-layers in `boundariesLayer.ts`; chip in `TopBar.tsx`.
4. **Agent-based mobility swarm (Phase 1)**: trafficsim network exported to a compact binary; browser-side gravity model (3 purposes, Furness balancing), 24 h diurnal curve, 5-mode logit choice, up to 25,000 agents in preallocated TypedArrays rendered by a deck.gl `ScatterplotLayer` in a 60 FPS rAF loop. Click a dot → route polyline + inspector card. Barangay O/D filter (all/from/to/both). Playback bar + "Mobility" tab in the analytics panel.
5. **Congestion (Phase 2, just finished, builds + tests green)**:
   - Binary format bumped to **v2** (adds `edgeCapacity` Float32 after `edgeLenKm`); loader still accepts v1 (capacity fallback 1200).
   - Mode physics exported in `mobility_zones.json`: puv 15–20 pax / 2.0 PCU, car 1–3 / 1.0, tricycle 1–4 / 0.6, motorcycle 1–2 / 0.4 (lane_filter 0.65), walk 1 / 0 PCU / `congests:false`.
   - BPR per-edge multiplier `min(8, 1 + 0.15·(V/C)^4)` with EMA smoothing (τ=4 sim-s); walkers excluded from carriageway load and offset 4.5 m to the right onto a "sidewalk"; mode choice uses live congested times; unit spawn weight = person-logit / avg occupancy (so a jeepney dot = 15–20 riders).
   - Color by Mode | Traffic Speed, congested-road ribbons (`PathLayer`, refreshed ~2 Hz), TTI / jammed-links / people-vs-units KPIs, inspector shows passengers, PCU, channel, live vs free speed, link V/C.

## 3. Key files

| Area | Files |
|---|---|
| Exporter | `scripts/export_trafficsim_network.py`, `scripts/test_export_trafficsim_network.py` (state source: `/home/daniel/Documents/trafficsim-20261114T161208Z-1-001/trafficsim_map/deploy/state/{state.npz,state.json}`) |
| Sim engine | `src/utils/mobilityTypes.ts`, `mobilityLoader.ts`, `mobilitySim.ts`, `src/layers/builtins/mobilityLayer.ts`, `src/__tests__/mobilitySim.test.ts` |
| Store | `src/layers/registry.ts` (all `mobility*` fields incl. congestion, color mode, show-roads) |
| Rendering loop | `src/components/TwinViewport.tsx` (rAF loop, `mobility-swarm-dots`, `mobility-congested-roads`, `selected-agent-route`) |
| UI | `MobilityPlaybackBar.tsx`, `MobilityTabPanel.tsx`, `AnalyticsPanel.tsx` (3rd tab), `FeatureInspector.tsx`, `src/styles/app.css` |
| Data | `public/data/bacolod/mobility_network.bin` (~5.9 MB, v2), `mobility_zones.json` (~736 KB), plus earlier buildings/POI/analytics assets |

Regenerate mobility assets: `npm run data:mobility` (≈ 30 s; reads 203k building footprints from PMTiles).

## 4. Binary contract (`mobility_network.bin`, little-endian, 4-byte aligned)

Header `u32[8]` = `[0x424D4F42, version(2), nNodes, nEdges, nPts, nZones, 3, 0]`, then `nodeLon f32`, `nodeLat f32`, `nodeElev f32`, `edgeSrc u16`(+pad), `edgeDst u16`(+pad), `edgeLenKm f32`, **`edgeCapacity f32` (v2 only)**, `edgeT0Sec f32[5·nEdges]` (walk, motorcycle, tricycle, car, puv), `geomOffs u32[nEdges+1]`, `geomCoords f32[2·nPts]` (lon,lat), `fromHubPrevEdge u16[3·nZones·nNodes]` (index `(profile·nZones+zone)·nNodes+node`, `0xFFFF` = root/unreachable; profiles 0 motorized, 1 tricycle, 2 walk). Current data: 11,138 nodes, 29,121 edges, 62 zones.

## 5. Known gaps / TODO (highest value first)

1. **No live browser QA of Phase 2.** Everything was verified by unit tests + `tsc` + `vite build` only. The `verifier` swarm worker was canceled by the user before running the visual pass. Please run `npm run dev` and check: swarm animates, Analytics → Mobility tab works, congestion toggle, ribbons appear at AM rush (~07:45), walkers visibly offset from road, click a jeepney (15–20 pax) and a pedestrian, Color by Traffic Speed, time scrubber, Sync Sun, console clean.
2. **Congestion calibration is unvalidated.** `CONCURRENT_CITY_PEOPLE_PEAK = 32000` and `pcuScale` clamp (0.1–25) in `mobilitySim.ts` are guesses; edge critical storage `K = max(1.2, capacity·t0_car/3600)` PCU. Confirm that arterials (Lacson, Circumferential, Araneta) jam at peak but not everywhere; tune `congestionLoadScale` defaults.
3. **Perf check at 25k agents**: `updateCongestionField` loops all agents + all 29k edges per frame; `spawnAgent` allocates small typed arrays (not zero-alloc as comments claim). Profile; consider updating congestion every N frames.
4. **Simplifications to be aware of**: routing is O(1) hub-tree (free-flow shortest path, no rerouting around jams); trip duration shown uses free-flow total with live remaining estimate; jeepneys move continuously (no boarding dwell); motorcycles get 65 % of BPR delay; agents respawn on arrival (no persistent agent identity/day schedules).
5. **Docs**: no walkthrough artifact was written for Phase 2 (`.../brain/4a22e7ae-.../walkthrough.md`). Nice to have.
6. Unused/minor: `src/utils/mobilitySim.ts` `getCongestedEdges` sorts all candidate edges each call (fine at 2 Hz).
7. Bundle is 2.37 MB (chunk-size warning only).

## 6. Swarm state

A native `/swarm` session ("Bacolod Agent-Based Mobility Swarm") exists with workers `data-exporter`, `sim-engine`, `ui-controls`, `app-integrator`, `verifier` (canceled), `monitor`. All Phase 1 work was posted `[done]` (board #15). Phase 2 was done directly (not via workers). The gemini model quota is nearly exhausted (resets 2026-11-26T17:25:55Z); workers can be ignored or killed. Do not rely on them.

## 7. Gotchas learned

- Overpass: query `nw["key"](bbox)` only (no relations/regex) and rotate endpoints, else timeouts.
- PMTiles z16 yields duplicate fragments (226,811 rows → 203,517 unique); stitch by `id` with `unary_union` (`load_stitched_buildings`).
- Shapely 2.x: use `shapely.transform(geom, fn)` not `shapely.ops.transform`.
- Foursquare OS Places (HF) is gated; only the Foursquare records embedded in Overture are used. Do not bypass the gate.
- tsc is strict about unused locals (`noUnusedLocals`): it failed the build twice on stray variables.
- The `edit_file` tool replaces *every* occurrence of a target; make targets unique.
- Terrain z-offset: agents at `elev·exaggeration + 3 m`, ribbons at `+2.2 m`.
- Mobility layer's `buildDeckLayer` intentionally returns `null`; `TwinViewport` builds the swarm layers imperatively per frame and pushes them via `overlay.setProps`.

## 8. Suggested next steps

1. Do the live QA pass in §5.1 and fix whatever it reveals.
2. Tune/validate congestion realism (§5.2) and profile (§5.3).
3. Optional features the user liked: periodic rerouting around jams, jeepney stop dwell at high-POI nodes, persistent agents with daily schedules, per-barangay accessibility/isochrone analytics fed by the mobility network.
4. Write `walkthrough.md` summarizing Phases 1–2 with screenshots.

User style preferences: concise replies, clickable `file://` links for files, report only verified command output, `/grill-me` style one-question-at-a-time clarification when design is ambiguous.
