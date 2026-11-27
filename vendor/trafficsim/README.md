# trafficsim (vendored)

Network, zone, demand and assignment code copied unchanged from the author's own `trafficsim_map`
project (copied 2026-11-27 from `~/Documents/trafficsim-20261114T161208Z-1-001/trafficsim_map`,
which is not under version control). It is the code that built Bacolod's calibrated simulation
network; `scripts/build_road_network.py` drives it headlessly for the other LGUs, feeding it OSM
roads from a Geofabrik extract instead of the Overpass API.

Do not edit these files in place. Adapt behaviour in `scripts/build_road_network.py`, so that a
fresh copy from trafficsim_map can replace this folder.

`states/bacolod/` is Bacolod's calibrated state (network, zones, mode constants), copied from that
project's `deploy/state/`. It is the input for Bacolod's simulation and the reference for every other LGU.

Not copied: the FastAPI app, GUI, editing tools, Overpass place lookup (`server/places.py`), and
the bundled Bacolod census CSV (populations come from `barangay_demographics.json` instead).
