# Data layers

What data the Bacolod City 3D Digital Twin uses today, where it comes from, how to rebuild it, and which free datasets we could add next.

How to read the status marks in section 4:
- **Checked**: licence or availability confirmed from a page or search result during this review (linked).
- **From notes**: taken from our own research notes (`trafficsim_map/research_notes/Bacolod barangay demand data/`), which flag some items as unverified.
- **From memory**: my general knowledge, not checked here. Confirm the licence before using.

Everything here is free to use. "Free" does not always mean "free to redistribute": ODbL data needs attribution and share-alike if we publish a derived database.

---

## 1. Current layers

All files live in `public/data/bacolod/` unless noted. Sizes as of 2026-11-27.

### 1.1 Base geography and buildings

| Layer | File | Source | Licence | Rebuild |
|---|---|---|---|---|
| Buildings (203,517 footprints) | `bacolod_buildings.pmtiles` (41 MB) | Overture Maps buildings, release 2026-11-18.0 (merges OSM, Esri, Google, Microsoft footprints) | ODbL | `npm run data:fetch` |
| Roads (28,304) | `bacolod_roads.pmtiles` (8.9 MB) | Overture transportation | ODbL | `npm run data:fetch` |
| Base features (water, land use, parks) | `bacolod_base.pmtiles` | Overture | ODbL | `npm run data:fetch` |
| Barangay boundaries (61) | `boundaries.geojson` | Overture divisions, OSM snapshot as fallback (Bacolod's current file was built with Overpass) | ODbL | `npm run data:fetch` |
| Building classes | inside buildings tiles | Computed: OSM tags and POIs, Overture classes, morphology rules, name keywords. 171,027 of 203,517 classified; 106,802 are "inferred" and 32,506 "unknown" | derived | `npm run data:osm` |
| Building heights | inside buildings tiles | Overture heights where present, Google Open Buildings 2.5D where it matches, otherwise estimated. Only 27 measured and 680 from floors; **202,810 (99.7%) are estimates** | derived | `npm run data:fetch`, `scripts/enrich_heights_25d.py` |
| Landmarks, labels | `building_labels.geojson`, `src/layers/builtins/landmarksLayer.ts` | Hand-curated list + building names | n/a | edited by hand |

### 1.2 Places of interest

| Layer | File | Source | Licence | Rebuild |
|---|---|---|---|---|
| POIs (6,883: OSM 2,252, Overture 4,126, Foursquare 55 matched) | `building_pois.json` (4 MB) | OSM snapshot (Bacolod's current file was built with Overpass); Overture Places (Meta, Microsoft, AllThePlaces, Uberall); Foursquare Open Source Places via Overture | ODbL (OSM); Overture Places and Foursquare are permissive, check the current release | `npm run data:osm` |
| POI trust votes (verified / unverified / unrated) | same file, fields `vote_score`, `trust`, `votes` | Computed from street match, source type and phone conflicts | derived | `uv run python -I scripts/score_poi_votes.py` (rerun after every `data:osm`) |
| POI heatmap | `poiHeatmapLayer.ts` | from `building_pois.json` | derived | n/a |

### 1.3 Terrain

| Layer | File | Source | Licence | Rebuild |
|---|---|---|---|---|
| Elevation grid, relief, slope, contours, Terrarium tiles | `dem/*` | Copernicus GLO-30 DEM (30 m) | Copernicus, free and open | `npm run data:dem` |

### 1.3b Hazards and land cover (added 2026-11-27)

| Layer | File | Source | Licence | Rebuild |
|---|---|---|---|---|
| Storm surge advisories 1-4 (reached by 2-3 m, 3-4 m, 4-5 m, over 5 m) | `hazards.geojson` (0.3 MB) | Project NOAH, UP Resilience Institute, province shapefiles (input in `data/noah/`, not served) | ODbL, credit Project NOAH, derived data stays ODbL | `npm run data:hazards` |
| Per-building hazard flags (surge advisory reaching it, elevation below 3 m) | `building_hazard.bin/json` (2.6 MB) | Same + Copernicus DEM | derived (ODbL) | `scripts/estimate_building_zonal_values.py` |
| Storm surge exposure by barangay (buildings and value) | inside `barangay_property.json` (`surge`, `surgeValue`) | same script | derived | same |
| Land-cover shares per barangay (tree, crop, built-up, grass, water...) | `barangay_landcover.json`; `tree_cover_pct`, `built_up_pct`, `cropland_pct` merged into `barangay_analytics.json` and `boundaries.geojson` | ESA WorldCover 10 m 2021 v200, clipped to Bacolod (input in `data/landcover/`) | CC BY 4.0 | `npm run data:landcover` (rerun after every `data:analytics`) |
| Population grid used for home weights | `data/popgrid/phl_pop_2020_CN_100m_R2025A_v1.tif` (63 MB, not served); stats in `mobility_zones.json` under `population_grid` | WorldPop Global2 R2025A, Philippines 2020, 100 m constrained | CC BY 4.0 | read by `npm run data:mobility` |
| Signals, crossings, stops, bus routes, tag-coverage audit | `transport_osm.json`, `transit_routes.geojson` | OSM snapshot (Geofabrik extract) | ODbL | `npm run data:transport` |

What each one actually changed (and where the data fell short):
- **NOAH flood maps (5, 25, 100-year) do not cover Bacolod City.** The shapefiles clip to under 5 km2 inside our bounding box and none of it lies inside the city, so `build_hazard_layers.py` drops them (recorded in `hazards.geojson` `meta.dropped`). Storm surge does cover the coast: 19.3% of buildings (about 29,600, estimated value near 29% of the city total) are reached by the largest modelled surge, 11,402 of them already at 2-3 m. River and rain flooding is still unmapped.
- **WorldCover cannot classify the 32,506 unknown buildings.** Cross-tabulating class against land cover: unknown buildings sit under tree cover 52% of the time (houses 37%, commercial 14%), which says they are not commercial but not what they are. Its real value is land cover itself: the city is about 42% tree canopy, 20% cropland, 20% built-up, against 0.5% mapped parks in OSM.
- **Population grid**: WorldPop sums to 571,215 inside the city versus 600,783 from PSA (95%). After rescaling to PSA per barangay, 5.9% of people land in cells with no residential buildings. Home weights now blend 50/50 with the grid's density (factors 0.6 to 3.0, clipped to 0.2 to 5).
- **OSM road attributes**: signals, lanes and maxspeed were checked. `trafficsim_map/osm_import.py` already reads `maxspeed`, `lanes` and `oneway`, and lane tags are common on trunk (98%) and primary (98%) roads but rare on tertiary (19%) and residential (2%) ones, so missing lanes matter little for the main corridors. Only 27 OSM traffic signals exist in Bacolod; 20 snapped to graph nodes and now add a 20 s expected delay for motorised modes (assumption: about half a typical cycle). OSM also holds 23 bus/jeepney route relations (19 city routes after dropping intercity coaches), now a map layer.

### 1.4 Economics and demographics

| Layer | File | Source | Licence | Rebuild |
|---|---|---|---|---|
| BIR zonal values (1,629 street entries) | `bir_zonal_values.json`, fields merged into `barangay_analytics.json` and `boundaries.geojson` | BIR RDO 77, Department Order 058-2023, effective 2023-11-01 (input in `data/bir_zonal/`) | public government document | `npm run data:zonal` (rerun after every `data:analytics`) |
| Per-building zonal value and structure estimate | `building_zonal.bin/json` (3.2 MB) | Computed: nearest named road to a BIR street, with fallbacks. Land = zonal x lot area; structure = footprint x floors x assumed cost. Assumptions are in the JSON | derived | `uv run python -I scripts/estimate_building_zonal_values.py` |
| Property value by barangay, low-lying exposure | `barangay_property.json` | Same script | derived | same |
| Barangay analytics (61) | `barangay_analytics.json` | Computed from buildings, POIs, DEM | derived | `npm run data:analytics` |
| Age structure by barangay | `barangay_demographics.json` | PSA 2020 Census of Population and Housing, single-year age by barangay, via HDX (input in `data/psa/`) | CC BY | `uv run python -I scripts/parse_psa_age_sex.py` |
| Trip purpose production per barangay | `barangay_demand.json` | Age bands x JICA Metro Cebu 2014 trip rates x an **assumed** age-to-purpose table; calibrated to the model's 48/35/17 | derived | `scripts/build_barangay_demand.py` |
| Barangay area types | `barangay_typology.json` | k-means (k = 4) on urban form, POIs, jobs, age structure | derived | `scripts/classify_barangays.py` |
| Site-selection catchment grid | `catchment_grid.json` | Computed from buildings and POIs | derived | with `data:analytics` |

Run the three demand scripts together with `npm run data:demand`, then `npm run data:mobility`.

### 1.5 Mobility

| Layer | File | Source | Licence | Rebuild |
|---|---|---|---|---|
| Road graph (13,429 nodes, 35,162 edges) | `mobility_network.bin` (7.4 MB) | Companion project `trafficsim_map` (OSM extracted via Overpass, 2026-11-15; other LGUs use the snapshot), exported by `scripts/export_trafficsim_network.py` | ODbL | `npm run data:mobility` |
| OSM province extract (roads, POIs, compounds, transit, activity buildings, admin boundaries); replaces all Overpass queries | `data/osm/negros-occidental/*.json` (not served) | Geofabrik Philippines extract (615 MB, `data/osm/geofabrik/`), cut by `scripts/extract_osm_region.py` in about 7 min | ODbL | `npm run data:osm-extract` (the pipeline runs it once per new download) |
| Road graph, zones and demand for LGUs other than Bacolod | `build/<place>/trafficsim_state/` | Province extract + the author's trafficsim_map code (`vendor/trafficsim/`), zones from our boundaries, population from PSA. Validated on Bacolod: 13,433 vs 13,429 nodes, zone jobs and students correlation 1.000 | ODbL / derived | `npm run data:network -- --place <slug>` (pipeline stage `network`) |
| Zones, skims, demand | `mobility_zones.json` | Same export + `barangay_demand.json` + `barangay_typology.json` | derived | `npm run data:mobility` |
| Building origin/destination table (153k) | `mobility_buildings.bin/json` | Same export | derived | `npm run data:mobility` |
| Street name per network edge | `mobility_edge_streets.json` | Nearest named OSM road within 25 m, from `scripts/export_edge_streets.py` | ODbL | runs after the export |
| Demand parameters | inside `mobility_zones.json` | JICA Metro Cebu 2014 household survey (2.97 trips/person/day, purpose shares, age rates). Bacolod has no survey of its own in our data | published report | n/a |

### 1.6 What the app builds from these (not stored as data)

Reports (`src/reports/`), the live and background simulation, corridor and trip-generation roll-ups, and the building inspector all read the files above. Nothing is fetched from a server at run time except these static files.

### 1.7 Pipeline order

The order is now encoded in `scripts/pipeline.py` (see `pipeline-plan.md`). Run it instead of the
individual `data:*` scripts:

```
npm run pipeline -- --place bacolod --offline   # rerun only what is out of date, no network
npm run pipeline -- --place bacolod --refresh   # re-fetch Overture / DEM, then everything downstream
npm run pipeline -- --list                      # stages and places
```

Stages, in order: place-meta, fetch, dem, osm, overrides, analytics, zonal, poi-votes, hazards,
building-values, transport, demographics, demand, typology, mobility, edge-streets, landcover, then
QA checks (barangay count, unassigned land, census match, size). Each place's settings live in
`regions/negros-occidental.json`; hand corrections (such as the Bata boundary) live in
`overrides/<place>/`. The old rules ("rerun zonal after analytics", "landcover after mobility") are
handled by stage fingerprints, so a change reruns exactly the stages downstream of it.

The single-step `npm run data:*` scripts still work and default to Bacolod; pass `-- --place <slug>`
to point one at another place.

---

## 2. Known weak spots in the current data

These are what the proposals below try to fix.

1. **Heights**: 99.7% of buildings have estimated heights, so 3D volume, floor area and structure value rest on a heuristic.
2. **Building class**: 16% unknown and 52% only inferred; residential is mostly inferred from shape.
3. **Population inside a barangay**: all buildings in a barangay are weighted by footprint, not by who lives there.
4. **Flooding**: storm surge is now mapped (Project NOAH), but river and rain flooding is not: NOAH's flood maps do not cover Bacolod. "Low-lying" is still elevation below 3 m on a 30 m DEM.
5. **POIs**: Overture and Foursquare pins are often wrong (see the Sugaree example); trust votes only flag them.
6. **Road attributes**: lanes, speed and one-way are used where OSM has them (well mapped on trunk and primary roads, thin on tertiary and residential); signals are sparse (27 in OSM) so most junction delay is still missing.
7. **Demand calibration**: there are no Bacolod traffic counts, so mode split (the background run gives about 70% walking) and trip lengths are unvalidated.
8. **Jobs and school seats**: attractions are modelled, not counted.
9. **Public transport**: OSM has 19 city route relations and 329 stops (a community map, not the official LPTRP); the simulation does not use them yet.

---

## 3. Proposals, grouped by value

Effort: S = a day or less, M = a few days, L = a week or more. Impact is what changes in the app.

### A. Do first: high impact, free, low risk

| # | Dataset | What it adds | Where it plugs in | Licence | Size / effort | Status |
|---|---|---|---|---|---|---|
| A1 | **DONE (surge only)** **Project NOAH hazard maps** (flood by return period, landslide, storm surge; shapefiles per province) | Real flood exposure instead of the 3 m elevation proxy. Buildings and estimated value at risk by hazard level | New layer + rewrite the "Low-lying exposure" report; per-building flood class in the inspector (point-in-polygon in `estimate_building_zonal_values.py`) | Open Data Commons ODbL (confirmed in NOAH's own `NOAH_License.pdf` and `metadata_flood.txt`, shipped with the mirror) | tens of MB, M | Checked: [Space Climate Observatory](https://www.spaceclimateobservatory.org/noah), mirror on [Hugging Face](https://huggingface.co/datasets/Siesta-22/project-noah-hazard-maps) (unofficial). NOAH says it is still in beta, so keep the source version in the file |
| A2 | **DONE (audited)** **More OSM road attributes**: `lanes`, `maxspeed`, `oneway`, `highway=traffic_signals`, crossings, `public_transport` stops, bus routes | Better capacity and free-flow speed on the graph, signal delay, stops for a transit layer | Extend the `trafficsim_map` Overpass pull and `export_trafficsim_network.py`; check first what the exporter already uses | ODbL | small, M | From notes: pipeline already uses Overpass |
| A3 | **DONE** **WorldPop 100 m constrained population** (R2025A), or Meta HRSL 30 m, or GHS-POP 100 m | Population inside each barangay at 100 m. Distribute each barangay's PSA total to buildings so home weights follow where people live | `mobility_buildings` home weights; barangay profile dot map; replaces footprint-only residential weighting. Rescale to PSA 2020 totals | WorldPop CC BY 4.0; HRSL CC BY; GHS-POP CC BY 4.0 | about 1-10 MB for Bacolod, M | From notes: [WorldPop hub](https://hub.worldpop.org/geodata/summary?id=78816) (1 km file confirmed; exact 100 m URL unverified). No study validating any of these against PSA barangay counts in the Philippines |
| A4 | **DONE (context, not classification)** **ESA WorldCover 10 m** (2020 and 2021) | Tree, crop, built-up, water, bare land at 10 m | Better green-space share; land-cover prior for the 32,506 unknown buildings and for "Parks & vegetation"; mask for the DEM | CC BY 4.0 | few MB, S | Checked: [AWS registry](https://registry.opendata.aws/esa-worldcover-vito/index.html), [ESA download page](https://worldcover2021.esa.int/download) |
| A5 | **PSA 2020 urban/rural flag and household counts** (HDX total population file) | Official urban/rural label per barangay; household size | Validate the classifier (PSA label versus our four types); household-based trip generation | CC BY | tiny, S | From notes: file listed, household counts per barangay not retrieved |

### B. Worth doing: medium impact

| # | Dataset | What it adds | Where it plugs in | Licence | Size / effort | Status |
|---|---|---|---|---|---|---|
| B1 | **GlobalBuildingAtlas** (TUM, 2025): footprints, 3 m height raster, LoD1 models for 2.75 billion buildings | A global height estimate from satellite imagery to replace the heuristic for 99.7% of buildings | Height prior or cross-check in `enrich_heights_25d.py`; compare against our estimates before replacing | Polygons appear to be ODbL; **height licence not confirmed** | tile download, M | Checked that it is open: [ESSD paper](https://essd.copernicus.org/articles/17/6647/2025/), [mediaTUM](https://mediatum.ub.tum.de/1782307). Licence for heights unverified |
| B2 | **Mapillary street-level detections** (signs, signals, lane markings, crosswalks) | Signals and speed limits where OSM is empty; photo links in the inspector | Network attributes; optional photo panel | CC BY-SA for images and map data (from memory); free API token | M | From memory |
| B3 | **DOH health facility list (NHFR)** | Official hospitals and clinics with type and bed class | Match to OSM/Overture pins to fix class and trust; weights for health-trip attraction | not verified | small, S | From notes: Excel/CSV by region, [page](https://nhfr.doh.gov.ph/VActivefacilitiesList) not live-checked; coordinates unconfirmed |
| B4 | **DepEd school list** (names, level, public/private) via OSM and the TeacherPH aggregator | Student counts per school as school-trip attractors; 155,524 learners city-wide in SY2024-25 | Replace modelled `students` per zone with school-level seats | Aggregator licence unclear; official enrolment is not open | S-M | From notes: [TeacherPH](https://www.teacherph.com/schools/divisions/bacolod-city) is a third party built from DepEd data |
| B5 | **Sentinel-2 / Landsat 8-9** derived layers: NDVI (greenness), land surface temperature, built-up change | Heat and vegetation exposure by barangay; change detection for new construction | New layers and a "Heat and green" report | Copernicus and USGS data are free and open (from memory) | needs cloud masking or GEE, M-L | From memory |
| B6 | **JRC Global Surface Water** | Where water has actually been seen: rivers, ponds, seasonal flooding | Cross-check for A1; fill gaps where NOAH has no map | free and open (from memory) | small, S | From memory |
| B7 | **VIIRS annual nighttime lights** (about 500 m) | Economic activity proxy for commercial attraction by barangay | Weight for "other" trips; sanity check on jobs | Described as public domain on [Earth Engine](https://developers.google.com/earth-engine/datasets/catalog/NOAA_VIIRS_DNB_ANNUAL_V22); EOG may need a free account | small, S | Checked on that page; confirm terms at [eogdata.mines.edu](https://eogdata.mines.edu/products/vnl/) |
| B8 | **Microsoft ML footprints and Google Open Buildings V3** | Footprint completeness check against Overture | Per-barangay count comparison; flag areas where Overture misses buildings | Microsoft CDLA Permissive 2.0; Google CC BY 4.0 or ODbL | large downloads, M | From notes. Overture already merges both, so the gain is a check, not new buildings |

### C. Need a request or manual work (free, not downloadable)

| # | Dataset | Why it matters | How |
|---|---|---|---|
| C1 | **Bacolod business permits (BPLO)**, 24,690 businesses in 2024 | The only way to get real jobs and business counts by barangay | FOI request via foi.gov.ph or a letter to BPLO; barangay address is almost certainly recorded |
| C2 | **CLUP 2017-2026 zoning map** (public PDFs on bacolodcity.gov.ph) | Official zones for commercial, industrial, institutional | Digitise the zoning map or request GIS from CPDO; intersect with barangays |
| C3 | **LPTRP jeepney routes** (24 routes, 1,099 units, City Ordinance 966 of 2021) | Route geometry for a public transport layer and mode-split validation | No open file found ([search](https://newsinfo.inquirer.net/2059014/comprehensive-profiling-of-puj-operators-underway-in-bacolod-city)); ask LTFRB Region 6 or CPDO, or digitise from consultation documents. The UP NCTS SimEx team (TSSP 2023) used route data and could be contacted |
| C4 | **Traffic counts (DPWH, City Traffic office, UP NCTS)** | The one thing that would let us calibrate the simulation | Request; even a handful of screenline counts would help |
| C5 | **NAMRIA barangay boundaries** | Official boundaries to replace OSM relations | Geoportal download or FOI; licence not confirmed (from notes) |
| C6 | **PSA barangay-level tables** (education, labour) | Real student and worker counts per barangay | PSA special tabulation request; LFS is only published for the city |

### D. Considered and not recommended

| Dataset | Why not |
|---|---|
| LandScan, GPWv4 | Too coarse (about 1 km) to improve on PSA barangay counts (from notes) |
| Kontur population | A blend of other products at 400 m; no gain over WorldPop or HRSL |
| Meta Relative Wealth Index | Non-commercial licence (from memory) and about 2.4 km cells |
| Google Popular Times, Google Maps traffic | Terms forbid scraping; not free to store |
| Uber Movement | Discontinued (from memory) |

---

## 4. Suggested order

1. **A1 flood hazard** and **A2 road attributes**: they fix the two weakest claims we currently make (flood exposure, congestion on named streets).
2. **A3 population grid** then **A5**: makes the trip-purpose and origin weighting follow real residents, and lets us validate the classifier.
3. **A4 land cover** and **B1 heights**: improve classification and the 3D model; do B1 only after checking its licence.
4. Send the **C1, C3, C4 requests now**, because they take weeks and unlock calibration.
5. **B2 to B8** as time allows.

## 5. Conventions for adding a layer

- One script per source in `scripts/`, run with `uv run python -I` when it reads downloaded files, with a unit test that does not need the download.
- Raw downloads go in `data/<source>/` (untrusted input, not served); only the small derived file goes in `public/data/<place>/`.
- Write the source, licence and date into the output JSON `meta`, and add a row to section 1 of this file.
- Take the place from `scripts/place.py` (`PLACE = current_place()`), never a hard-coded bbox or city name.
- Add a `Stage` to `scripts/pipeline.py` with its dependencies, raw inputs and outputs.
- Anything modelled rather than measured gets a caveat in the UI and in any report that uses it.
