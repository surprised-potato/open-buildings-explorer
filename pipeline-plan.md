# Plan: a continuous pipeline for every LGU in Negros Occidental

Status: all 32 LGUs built and passing QA (2026-11-27); publishing via the `data` branch prepared. Written 2026-11-27. Scope narrowed to Negros Occidental the same day so the site fits on free GitHub Pages hosting. Negros Oriental and Siquijor can follow later with the same pipeline.

## 1. Scope

The PSA 2020 census file already in `data/psa/` gives the scope:

| | LGUs | Barangays | Population 2020 |
|---|---|---|---|
| **Negros Occidental** | **32** (Bacolod, 13 component cities, 18 municipalities) | **662** | **3,223,955** |
| of which Bacolod (live today) | 1 | 61 | 600,783 |
| still to add | 31 | 601 | 2,623,172 |

The largest LGUs to add are Kabankalan (200k), Bago (191k), Cadiz (159k), Sagay (149k), San Carlos (133k), Silay (130k), Himamaylan (116k), Talisay (109k) and Cauayan (108k).

## 2. What has to change (from an audit of the current code)

The pipeline was built for one city and hard-codes it everywhere:

- **Scripts:** about 20 scripts carry Bacolod constants: bounding boxes in 6 files, `lat0 = 10.676` in 3, the `BACOLOD_BARANGAYS` list, the PSA filter `CITY OF BACOLOD`, the BIR file `RDO77_Bacolod…xls`, and output to `public/data/bacolod/`.
- **Front end:** 18 files read `data/bacolod/…` directly. The camera presets, landmarks, home view and sample layers are all Bacolod coordinates.
- **Manual fixes:** fixes live in one-off scripts (`fix_bata_boundary.py`) rather than as data.
- **Run order:** the order exists only as notes in `datalayers.md`. Analytics must run before zonal and land cover, OSM before POI votes, and everything before mobility.
- **Fetching:** Overpass is called live and per city. That will not survive 32 LGUs, since the public endpoints rate-limit and the main one was down during the last run.

## 3. Target design

### 3.1 One registry for all places
`regions/negros-occidental.yaml` holds one entry per LGU:
- PSGC code, name and slug (`bacolod`, `talisay`, `kabankalan`, …) and type (city or municipality).
- Bounding box and centre, derived from the boundary and cached.
- BIR RDO and the matching workbook.
- Simulation region (see 3.5).
- Status: `pilot`, `live` or `paused`.
- Path to its manual overrides.

Barangay lists come from PSGC through the PSA file, never from hand-typed sets.

### 3.2 Province-level inputs, fetched once per refresh

| Input | Today | For the province |
|---|---|---|
| Overture buildings, places, divisions | DuckDB query per city bbox | One query over the province bbox to local GeoParquet, then clip per LGU |
| OSM (buildings, roads, POIs, transit, signals) | Overpass per city | Geofabrik `philippines-latest.osm.pbf`, cut to the province with `osmium extract`, then filter per LGU. No rate limits, reproducible snapshot date |
| DEM | Bacolod tiles | Copernicus GLO-30 tiles for the province |
| WorldPop 100 m | national file (already have) | reuse |
| PSA age by barangay | national file (already have) | reuse |
| ESA WorldCover | Bacolod clip | the province's tiles |
| NOAH flood + surge | Negros Occidental zips (already have) | reuse. The flood maps cover the province: about 1,065 km² of hazard, about 52 km² of it around Talisay, Silay and Bago, none in Bacolod |
| BIR zonal values | RDO 77 workbook | one workbook per RDO covering the province (list to confirm on the BIR site; layouts differ, so expect one small parser adapter each) |

Barangay boundaries: Overture left a 4 km² hole in Bacolod (Bata). Across 662 barangays that will happen again. Evaluate the PSA/NAMRIA admin-4 boundaries on HDX (COD-AB) as the primary source, with Overture and OSM as fallbacks. Check the licence first.

### 3.3 Per-LGU stages as one DAG
`scripts/pipeline.py` (plain Python, no new framework) runs named stages for `--lgu <slug>` or `--all`:

```
extract (clip province inputs) → boundaries (+ overrides) → buildings/OSM enrich → heights
→ analytics → zonal parse → building zonal + hazard → land cover → POI votes
→ demand (PSA ages, trip purpose, typology) → mobility network + edge streets
→ QA gate → package
```

- **Incremental:** each stage declares its inputs and outputs and records input hashes in `build/<slug>/stamps.json`. A rerun skips any stage whose inputs did not change. This replaces the "remember to rerun X after Y" notes.
- **Scripts:** existing scripts become stage functions that take a `Place` config object instead of constants. They stay testable; the current 13 Python test files keep running.
- **Manual corrections become data:** `overrides/<slug>/boundaries.geojson` (the Bata patch), `pois.csv` and `notes.md`. The overrides stage applies them every run, so a re-fetch never silently drops a fix.

### 3.4 Quality gates (a place is published only if it passes)
- **Boundaries:** barangay count equals PSGC. Unassigned land inside the LGU is under 0.5 km², which is exactly what would have caught Bata.
- **Population:** PSA match for every barangay, and WorldPop within ±15% of PSA.
- **Buildings:** count within ±10% of the last published run, unless the Overture release changed.
- **Mobility:** no zone unreachable. Mean trip time, intra-zone share and walk share stay inside set bands.
- **Size:** each place stays within its share of the size budget (3.7).
- **On failure:** keep the last good version live and open a GitHub issue with the report.

### 3.5 Simulation regions, not single LGUs
Commuting crosses LGU lines, so a city-only simulation is wrong at the edges. Group LGUs into functional regions and run one simulation each:
- **Metro Bacolod:** Bacolod, Talisay, Silay, Bago, Murcia. Done first.
- **Other urban clusters:** candidates are north (Victorias, Manapla, Cadiz, Sagay, E.B. Magalona) and south (Himamaylan, Kabankalan, Binalbagan, Isabela). Confirm these with commuting evidence before building them.
- **Remaining municipalities:** analytics and reports only at first, without a simulation.

Trip rates: the Cebu survey rates fit urban areas. Rural areas need a different set, or at least a flag in the UI.

### 3.6 Front end
- `places.json` lists the published LGUs with their data version, centre and bbox. The app adds a place switcher, and the URL hash carries `place=`.
- One `dataBase(place)` helper replaces the 29 hard-coded `data/bacolod/` paths.
- Per-place `place.json` holds the camera presets, landmarks and home view.
- A province overview: one choropleth of all 662 barangays, with click-through to an LGU.
- Reports gain a place selector and cross-LGU comparisons.

### 3.7 Hosting: staying on GitHub Pages

Size budget, estimated from Bacolod (95 MB for 203k buildings) and scaled by population with rural adjustments. Measure the real numbers during the pilots (phase 2).

| Item | Bacolod today | Province estimate | How it is kept down |
|---|---|---|---|
| Buildings PMTiles | 40 MB | ~200–250 MB | one province file, not 32 copies |
| Roads PMTiles | 8.5 MB | ~60–100 MB | one province file; lower max zoom for rural roads |
| DEM / terrain | 15 MB | ~80–100 MB | coarser tiles outside built-up areas |
| Per-building binaries (zonal, hazard, POIs, sim buildings) | 21 MB | ~110–140 MB | already compact; sim binaries only for simulation regions |
| Everything else (JSON, network, GeoJSON) | 10 MB | ~40–60 MB | |
| **Total** | **95 MB** | **~0.5–0.65 GB** | Pages limit is 1 GB |

This fits, with about 35–50% headroom.

Remaining problem: committing about 0.6 GB of regenerated data to `main` every month would grow the repo history by that much each time. Fix:
- Generated data lives on an orphan `data` branch that each refresh **force-pushes as a single commit**, so the history never accumulates. GitHub garbage-collects the old copies.
- The Pages workflow checks out `main` for the app and `data` for `public/data/`, builds, and deploys. Code changes and data refreshes deploy independently.
- `main` stops tracking `public/data/` (it is about 95 MB in history today; that stays, but it stops growing).
- Rollback: tag a data commit before overwriting it if a version needs keeping (for example `data-2026-12`). Tags keep that one snapshot alive, so prune them.
- Pages also has a soft bandwidth limit of about 100 GB a month, ample for this use.

If the measured total lands near 1 GB, the escape hatch is moving the two PMTiles files to Cloudflare R2. The app already loads them by URL, so that is a config change.

### 3.8 Running it continuously
GitHub Actions, free for public repos:
- **Monthly refresh:** after each Overture release (and a fresh OSM snapshot), a scheduled workflow runs extract once, then a matrix of per-LGU jobs (about 5 at a time), then QA, then force-pushes the `data` branch, which triggers the Pages deploy.
- **On push:** a change to `overrides/` or a script reruns only the affected places, using the stage hashes.
- **Raw inputs:** the national PSA and WorldPop files, NOAH zips and BIR workbooks are not in git today (`data/` is ignored). Fetch them in CI from their sources and cache them with the Actions cache (10 GB). BIR workbooks may need manual download, so keep those in a small `inputs` release asset.
- **Limits to design around:** jobs run on a 4 vCPU, 16 GB runner with a 6-hour job cap and about 14 GB of disk. A per-LGU job should take minutes. The province extract is the heavy one.
- **Record of every run:** the manifest stores the source versions (Overture release, OSM timestamp, BIR order) and the QA summary.

## 3.9 End state: one command per province

`npm run pipeline -- --province "<name>"` should do everything:
- Build the LGU list from PSA.
- Download every source snapshot it needs, with caching and checksums and no live API queries: Geofabrik OSM, PSA, WorldPop, WorldCover, Copernicus DEM, NOAH, and an Overture province extract.
- Configure each LGU from those snapshots (outline, extent, barangays).
- Run all stages for every LGU, then QA.

Only the BIR zonal workbooks remain a manual input. The pipeline lists the missing ones and continues without them. (Goal set by the user on 2026-11-27.)

## 4. Phases

1. **Generalise without changing Bacolod.** Add the registry, the `Place` config, `pipeline.py` with stamps, overrides as data, and the front-end `dataBase` plus the `place.json` split. Acceptance: regenerated Bacolod data matches today's output, apart from timestamps, and the 86 front-end tests and 13 Python test files pass.
   - **Done 2026-11-27.**
     - Registry: `regions/negros-occidental.json` (JSON rather than YAML, to avoid a new dependency).
     - Place config: `scripts/place.py`; every script takes `--place`.
     - Runner: `scripts/pipeline.py` with fingerprints and QA.
     - Overrides: `overrides/bacolod/` (Bata boundary, view presets and landmarks).
     - Front end: `src/utils/place.ts` plus `place.json` / `places.json`; `#place=<slug>` selects a place.
   - **Result:** regenerated Bacolod data matches the pre-refactor files apart from timestamps: 114 of 115 identical. `hazards.geojson` differs only because the old file predated the Bata fix, and the old script reproduces the new file exactly. Tests: 89 front-end, 15 Python files.
   - **Found while doing it:**
     - Bacolod's simulation road graph comes from a separate, calibrated `trafficsim_map` project folder outside this repo. Other places need a road graph built from OSM / Overture first, which is a new piece of phase 2.
     - Overture/Overpass, the DEM and OSM POI stages cannot be rerun offline. They are guarded by a test pinning Bacolod's registry values to the old constants, not by a rerun.
2. **Pilot four LGUs that stress different parts.** Talisay (metro neighbour, inside the flood maps), Kabankalan (largest, rural, river flooding), Cadiz or Sagay (north coast, another BIR RDO) and one small municipality such as Pulupandan or Salvador Benedicto. Measure real sizes against the budget in 3.7. Expect parser fixes for BIR workbooks and sparse rural OSM.
   - **Road networks: hybrid route (decided 2026-11-27).** Overpass is too slow for bulk downloads, so it is not used for new LGUs.
     - OSM comes from one Geofabrik Philippines file (615 MB), cut to the province once by `scripts/extract_osm_region.py`. The cut gives roads, the activity POIs and buildings trafficsim's economy model counts, and the admin boundaries.
     - `scripts/build_road_network.py` runs the author's trafficsim_map code, copied unchanged into `vendor/trafficsim/`, to build the graph, zone connectors, economy and demand, and to calibrate the mode constants.
     - Zones come from our barangay boundaries and zone population from PSA.
     - Jobs and student totals are population times Bacolod's per-resident ratios. This is an assumption, written into each `network_report.json`.
     - Bacolod keeps its original calibrated state.
     - **Overpass removed (2026-11-27).** `osm` (POIs, compounds), `transport` (signals, crossings, stops, routes, road audit) and the `fetch` boundary fallback all read the province extract through `scripts/osm_snapshot.py`. No live OSM call is left in the scripts.
       - Checked on Bacolod: transit counts and the road-tag audit (11,355 roads) are identical to the Overpass results, as is the map layer.
       - Only intercity coach routes lose their geometry outside the province.
       - POIs: 2,348 usable from the snapshot. Compounds: 830. Boundary fallback: the city outline plus 60 of 61 barangays.
     - **Still read live, but from fixed versioned releases:** Overture (S3) and the Copernicus DEM. Both are due to become downloaded snapshots under 3.9.
     - **Measured 2026-11-27:**
       - The province cut takes 6 min 40 s and 2.3 GB of RAM. It yields 57,642 road ways, 17,134 activity POIs and 20,910 activity buildings.
       - Rebuilding Bacolod this way takes 17.6 s. The result is 13,433 vs 13,429 road nodes and 2,927 vs 2,926 road km.
       - Zone population, jobs, students and commerce all correlate at 1.000 with the original.
       - Mode calibration reaches the targets within 0.6 points in 2 rounds.
     - **OSM boundaries:** all 32 LGU outlines are in the extract, but only 280 of 662 barangay outlines. Barangay zones for new LGUs therefore come from Overture divisions, with OSM as the fallback.
3. **Province inputs and the data branch.** Geofabrik plus osmium, the province Overture extract, province PMTiles, the orphan `data` branch and the two-checkout Pages workflow.
4. **Metro Bacolod simulation.** Re-check the Burgos/Montelibano corridor once Talisay and Silay commuters are in.
5. **Roll out all 32**, with the place switcher and province overview.
6. **Automate:** the scheduled workflow, QA issues and a run log page.

## 5. Decisions needed from you
1. **Simulation:** Metro Bacolod only at first (recommended), or other clusters too?
2. **Refresh:** monthly (with Overture), or quarterly?
3. **Downloads:** each new source needs your OK: the BIR workbooks per RDO, the Geofabrik extract, the DEM and WorldCover tiles, and the HDX admin boundaries. Phase 1 needs none of these.

## 6. Risks
- **BIR workbooks:** they differ by RDO and are updated irregularly. Some LGUs may get only barangay-level values.
- **Rural OSM:** coverage is thin, so most rural buildings will be "unknown" class. WorldCover helps for land cover but cannot classify buildings.
- **Size estimate:** the budget in 3.7 is extrapolated, not measured. The pilots measure it before the full rollout.
- **Boundary disputes:** these exist between some LGUs. Use PSGC and NAMRIA as the reference and record any override.
- **Free-tier changes:** free-tier limits (Actions, Pages) can change. Keep the pipeline runnable locally with one command.


## 7. Province run, 2026-11-27 (what was actually built)

**One-time downloads,** all reused by every LGU:
- Geofabrik OSM, 615 MB.
- Overture province extract (`extract_overture_region.py`), 235 MB.
- Copernicus DEM province mosaic, 61 MB, and WorldCover, 12 MB (`fetch_region_rasters.py`).

**Automatic LGU setup:** `configure_places.py` sets up each LGU from its OSM outline and the PSA barangay list. `init_place_views.py` adds town-centre views.

**Barangay outlines:** Overture plus OSM give real outlines for 121 of the 601 new barangays.
- Most of the rest get an approximate outline: the land nearest their Overture or OSM point.
- Barangays with no location at all join a combined town-centre zone, so their residents stay in the model.
- Every outline records its `boundary_source`.
- Victorias is the weakest: 20 of its 26 barangays are in the combined zone.

**BIR:** kept as a separate pipeline (`npm run bir`). Only Bacolod has a workbook. The other LGUs have structures, hazards and everything else, but no land values.

**Size:** 762 MB in 2,863 files.
- Terrain tiles and contours are shared province-wide in `public/data/_region/`.
- New LGUs serve storm surge only; the flood polygons are kept in `build/<place>/hazards_full.geojson` for a future flood layer.

**Publishing:** `public/data/` is no longer tracked on `main`. `scripts/publish_data.py` force-pushes it as one commit to the `data` branch, and the Pages workflow combines the two branches.
