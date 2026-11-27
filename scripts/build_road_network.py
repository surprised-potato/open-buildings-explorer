"""Build a place's simulation network, zones and demand (a trafficsim_map "state") without Overpass.

The "hybrid" route of pipeline-plan.md:
  roads, activity POIs, activity buildings  <- OSM, cut from a Geofabrik extract (extract_osm_region.py)
  graph, zone connectors, economy, demand,
  mode calibration                          <- the author's trafficsim_map code (vendor/trafficsim), unchanged
  zones                                     <- our barangay boundaries (PSA-checked, overrides applied)
  zone population                           <- barangay_demographics.json (PSA 2020)
  mode constants, demand parameters         <- Bacolod's calibrated state (the reference), then re-calibrated
                                               so each place's mode shares hit the same targets

Output: build/<place>/trafficsim_state/state.{json,npz}, the format export_trafficsim_network.py reads, and
build/<place>/network_report.json with counts, coverage, calibration and the assumptions used.

Places with their own `trafficsim_state_dir` in the registry (Bacolod) keep that calibrated state; this
script is for the others. Run: uv run python scripts/build_road_network.py --place talisay
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, Place, add_place_argument, current_place, get_place  # noqa: E402

sys.path.insert(0, str(REPO_ROOT / "vendor" / "trafficsim"))
import osm_import  # noqa: E402
from engine import assign as fast_assign  # noqa: E402
from server import economy, store  # noqa: E402
from server.project import Project  # noqa: E402

PLACE = current_place()
REGION_OSM = REPO_ROOT / "data" / "osm" / "negros-occidental"
CLIP_MARGIN_DEG = 0.01
CALIBRATION_ROUNDS = 14
POP_SOURCE = "PSA 2020 Census of Population and Housing (via HDX, CC BY)"


def reference_state_dir() -> Path:
    ref = get_place("bacolod").trafficsim_state
    if not ref:
        raise SystemExit("The reference place (bacolod) has no trafficsim_state_dir in the registry")
    return ref


# ---------------------------------------------------------------- geometry helpers

def outer_ring(geom: dict) -> list[tuple[float, float]]:
    """GeoJSON Polygon/MultiPolygon -> largest outer ring as [(lat, lon)] (trafficsim's convention)."""
    from shapely.geometry import shape

    g = shape(geom).buffer(0)
    if g.geom_type == "MultiPolygon":
        g = max(g.geoms, key=lambda p: p.area)
    return [(round(y, 7), round(x, 7)) for x, y in list(g.exterior.coords)[:-1]]


def ring_bbox(ring: list[tuple[float, float]], margin: float = 0.0) -> tuple[float, float, float, float]:
    la = [p[0] for p in ring]
    lo = [p[1] for p in ring]
    return min(la) - margin, min(lo) - margin, max(la) + margin, max(lo) + margin


def clip_elements(elements: list[dict], bbox: tuple[float, float, float, float]) -> list[dict]:
    """Keep elements with any point inside bbox (S, W, N, E)."""
    s, w, n, e = bbox
    out = []
    for el in elements:
        if "geometry" in el:
            pts = el["geometry"]
            if any(s <= p["lat"] <= n and w <= p["lon"] <= e for p in pts):
                out.append(el)
        else:
            c = el.get("center") or el
            if s <= c["lat"] <= n and w <= c["lon"] <= e:
                out.append(el)
    return out


def load_elements(name: str, osm_dir: Path) -> list[dict]:
    path = osm_dir / name
    if not path.exists():
        raise SystemExit(f"{path} is missing: run scripts/extract_osm_region.py first")
    return json.loads(path.read_text(encoding="utf-8"))["elements"]


# ---------------------------------------------------------------- calibration (from trafficsim server/app.py)

def calibrate_modes(P: Project, rounds: int = CALIBRATION_ROUNDS) -> dict[str, Any]:
    """Tune mode constants so modelled mode shares match each mode's target (same loop as trafficsim's
    /api/modes/calibrate)."""
    cfg = [dict(c) for c in P.mode_cfg]
    tgt = np.array([max(float(c.get("target", 0)), 1e-4) for c in cfg])
    tgt = tgt / tgt.sum()
    hist: list[float] = []
    sh = tgt
    for _ in range(rounds):
        P.mode_cfg = cfg
        P.modes = economy.mode_objects(cfg, P.b_cost, P.b_dur)
        P.prepare_modes()
        res = fast_assign.assign(P.net, dict(P.modes), dict(P.od), max_iterations=2, gap_tolerance=1.0)
        tot = sum(res.mode_trips.values()) or 1.0
        sh = np.array([res.mode_trips[c["id"]] / tot for c in cfg])
        err = float(np.abs(sh - tgt).max())
        hist.append(round(err, 4))
        if err < 0.01:
            break
        for c, s_, t_ in zip(cfg, sh, tgt):
            c["asc"] = float(c.get("asc", 0)) + 0.8 * math.log(t_ / max(s_, 1e-4))
        base = cfg[0]["asc"]
        for c in cfg:
            c["asc"] = round(c["asc"] - base, 4)
    P.install_modes(cfg)
    return {"error_history": hist, "shares": {c["id"]: round(float(s_), 4) for c, s_ in zip(cfg, sh)},
            "targets": {c["id"]: round(float(t_), 4) for c, t_ in zip(cfg, tgt)}}


# ---------------------------------------------------------------- build

def build(place: Place, boundaries: dict, demographics: dict, osm_dir: Path, ref_dir: Path,
          calibrate: bool = True) -> tuple[Project, dict[str, Any]]:
    t0 = time.time()
    report: dict[str, Any] = {"place": place.slug, "assumptions": []}
    ref = json.loads((ref_dir / "state.json").read_text(encoding="utf-8"))

    feats = boundaries["features"]
    city = next(f for f in feats if f["properties"].get("level") == "city")
    city_ring = outer_ring(city["geometry"])
    clip = ring_bbox(city_ring, CLIP_MARGIN_DEG)

    roads = clip_elements(load_elements("roads.json", osm_dir), clip)
    P = Project()
    nodes, edges = osm_import.build_graph({"elements": roads}, next(iter(P.modes)), polygon=city_ring, max_edges=None)
    if not edges:
        raise SystemExit(f"No roads inside {place.display_name}")
    P.load_objects(nodes, edges, name=f"{place.name} (OSM, Geofabrik)")
    P.boundary = [list(p) for p in city_ring]
    report["network"] = {"ways_in_clip": len(roads), "nodes": len(nodes), "edges": len(edges)}

    # Zones: one per barangay from our boundaries, population from PSA.
    brgys = sorted((f for f in feats if f["properties"].get("level") == "barangay"), key=lambda f: f["properties"]["name"])
    P.add_zones([{"name": f["properties"]["name"], "polygon": outer_ring(f["geometry"])} for f in brgys])
    demo = demographics.get("barangays", {})
    missing_pop = []
    for z in P.zones:
        rec = demo.get(z["name"])
        if rec:
            z.update(pop=int(rec["population"]), pop_year=2020, pop_src=POP_SOURCE)
        else:
            missing_pop.append(z["name"])
    report["zones"] = {"count": len(P.zones), "without_population": missing_pop}

    # Economy: trafficsim's activity counts and floor area, from the same OSM extract.
    pois = clip_elements(load_elements("econ_pois.json", osm_dir), clip)
    bldgs = clip_elements(load_elements("econ_buildings.json", osm_dir), clip)
    counts = economy.count_by_zone(pois, P.zones)
    floors = economy.floor_by_zone(bldgs, P.zones)
    for z in P.zones:
        z["poi"] = counts.get(z["id"], {})
        z["floor"] = {k: round(v, 1) for k, v in floors.get(z["id"], {}).items()}
    econ = copy.deepcopy(ref["econ"])
    ref_pop = float(sum(float(z.get("pop") or 0) for z in ref["zones"]))
    pop = float(sum(float(z.get("pop") or 0) for z in P.zones))
    for key in ("jobs_total", "students_total"):
        per_person = float(ref["econ"][key]) / ref_pop
        econ[key] = round(pop * per_person)
        report["assumptions"].append(
            f"{key} = population x Bacolod's {per_person:.3f} per resident (no LGU-level labour-force or enrolment figure loaded)")
    econ["enabled"] = True
    P.econ = econ
    summary = P.economic_demand()
    report["economy"] = {"pois": len(pois), "activity_buildings": len(bldgs), "jobs_total": econ["jobs_total"],
                         "students_total": econ["students_total"], "population": pop,
                         "trips": round(float(summary.get("trips", 0) or summary.get("total_trips", 0) or 0), 1)}

    # Modes: start from Bacolod's calibrated constants, then re-fit to the same target shares.
    P.install_modes(ref["mode_cfg"], ref.get("b_cost"), ref.get("b_dur"))
    report["assumptions"].append("Mode constants start from Bacolod's calibrated values; targets are Bacolod's (Cebu survey) shares")
    if calibrate:
        report["calibration"] = calibrate_modes(P)
    report["seconds"] = round(time.time() - t0, 1)
    return P, report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_place_argument(ap)
    ap.add_argument("--osm-dir", type=Path, default=REGION_OSM)
    ap.add_argument("--reference-state", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=REPO_ROOT / "build" / PLACE.slug / "trafficsim_state")
    ap.add_argument("--no-calibrate", action="store_true")
    args = ap.parse_args()

    boundaries = json.loads((PLACE.out_dir / "boundaries.geojson").read_text(encoding="utf-8"))
    demo_path = PLACE.out_dir / "barangay_demographics.json"
    demographics = json.loads(demo_path.read_text(encoding="utf-8")) if demo_path.exists() else {}
    P, report = build(PLACE, boundaries, demographics, args.osm_dir, args.reference_state or reference_state_dir(),
                      calibrate=not args.no_calibrate)
    store.save(P, str(args.out))
    (args.out.parent / "network_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    cal = report.get("calibration", {})
    print(f"{PLACE.slug}: {report['network']['nodes']} nodes, {report['network']['edges']} edges, "
          f"{report['zones']['count']} zones; calibration error {cal.get('error_history', ['-'])[-1]}; "
          f"{report['seconds']}s -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
