"""Fill in each LGU's registry settings automatically from the downloaded snapshots.

For every place without a bbox (or all with --force), using only local files:
  outline     OSM snapshot admin boundary (admin_level 6/7) whose name matches the LGU
  bbox etc.   outline bounds + margins; centre = a point inside the outline; DEM grid sized like Bacolod's
  barangays   PSA 2020 census names for the LGU (the authoritative list)
  matching    how many barangays have an outline in Overture or OSM, or only an Overture point; the rest
              get an approximate outline in fetch_bacolod.py (see fill_missing_barangays)
Writes regions/<region>.json (status planned -> pilot) and build/configure_report.json.
Run: uv run python -I scripts/configure_places.py [--place talisay] [--force]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from names import best_match, lgu_key, match_key  # noqa: E402
from place import REGIONS_DIR, REPO_ROOT, load_region  # noqa: E402

PSA_XLSX = REPO_ROOT / "data" / "psa" / "2020_popn_single_age_admin4.xlsx"
OSM_BOUNDS = REPO_ROOT / "data" / "osm" / "negros-occidental" / "boundaries.geojson"
OVERTURE = REPO_ROOT / "data" / "overture" / "negros-occidental"
DEG_PER_GRID_CELL = 0.27 / 486  # Bacolod's DEM sampling grid spacing (about 60 m)
MAX_GRID = 1400


def clean_psa_name(name: str) -> str:
    return re.sub(r"\s*\(.*?\)\s*", " ", str(name)).strip()


def psa_barangays(province: str) -> dict[str, list[str]]:
    import openpyxl

    wb = openpyxl.load_workbook(PSA_XLSX, read_only=True)
    out: dict[str, list[str]] = defaultdict(list)
    for i, row in enumerate(wb[wb.sheetnames[0]].iter_rows(values_only=True)):
        if i == 0 or len(row) < 7 or str(row[1]).strip().upper() != province:
            continue
        out[str(row[2]).strip()].append(clean_psa_name(row[3]))
    return out


def osm_places() -> list[dict]:
    path = REPO_ROOT / "data" / "osm" / "negros-occidental" / "places.json"
    return json.loads(path.read_text(encoding="utf-8"))["elements"] if path.exists() else []


def overture_divisions() -> tuple[list[dict], list[dict]]:
    """(points, areas) from the local Overture divisions snapshot."""
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    d = OVERTURE / "divisions-division.parquet"
    a = OVERTURE / "divisions-division_area.parquet"
    pts = [{"id": r[0], "name": r[1], "subtype": r[2], "lon": r[3], "lat": r[4]} for r in con.execute(
        f"SELECT id, names.primary, subtype, ST_X(geometry), ST_Y(geometry) FROM read_parquet('{d}') "
        "WHERE names.primary IS NOT NULL AND ST_GeometryType(geometry) = 'POINT'").fetchall()]
    areas = [{"division_id": r[0], "name": r[1], "subtype": r[2], "wkb": bytes(r[3])} for r in con.execute(
        f"SELECT a.division_id, d.names.primary, d.subtype, ST_AsWKB(a.geometry) FROM read_parquet('{a}') a "
        f"JOIN read_parquet('{d}') d ON d.id = a.division_id WHERE d.names.primary IS NOT NULL").fetchall()]
    return pts, areas


def configure(entry: dict[str, Any], outline, brgy_names: list[str], osm_brgys: list[dict], ov_pts: list[dict],
              ov_areas: list[Any]) -> dict[str, Any]:
    from shapely import wkb
    from shapely.geometry import Point, shape

    minx, miny, maxx, maxy = outline.bounds
    r6 = lambda v: round(v, 4)
    bbox = [r6(minx - 0.005), r6(miny - 0.005), r6(maxx + 0.005), r6(maxy + 0.005)]
    analysis = [r6(minx - 0.01), r6(miny - 0.01), r6(maxx + 0.01), r6(maxy + 0.01)]
    terrain = [r6(minx - 0.04), r6(miny - 0.04), r6(maxx + 0.04), r6(maxy + 0.04)]
    c = outline.representative_point()
    gw = min(MAX_GRID, max(60, round((analysis[2] - analysis[0]) / DEG_PER_GRID_CELL)))
    gh = min(MAX_GRID, max(60, round((analysis[3] - analysis[1]) / DEG_PER_GRID_CELL)))

    inside = outline.buffer(0.002)
    osm_keys = {match_key(f["properties"]["name"]) for f in osm_brgys
                if inside.contains(shape(f["geometry"]).representative_point())}
    area_keys = {match_key(a["name"]) for a in ov_areas
                 if inside.contains(wkb.loads(a["wkb"]).representative_point())}
    pt_keys = {match_key(p["name"]) for p in ov_pts if inside.contains(Point(p["lon"], p["lat"]))}
    pt_keys |= {match_key(p["tags"]["name"]) for p in osm_places() if inside.contains(Point(p["lon"], p["lat"]))}
    status = {}
    for n in brgy_names:
        k = match_key(n)
        status[n] = ("overture" if best_match(k, area_keys) else "osm" if best_match(k, osm_keys)
                     else "point" if best_match(k, pt_keys) else "none")
    entry.update({
        "file_prefix": entry["slug"],
        "bbox": bbox, "analysis_bbox": analysis, "terrain_bbox": terrain,
        "center": [round(c.x, 5), round(c.y, 5)], "lat0": round(c.y, 4),
        "dem_grid": [gw, gh],
        "barangays": sorted(brgy_names),
        "noah_province": "NegrosOccidental",
        "size_budget_mb": 150,
        "boundary_mode": "fill",
        "hazard_simplify_deg": 1e-4,
        "hazard_clip_to_city": True,
        "contour_interval_m": 10,
        "contour_major_m": 50,
        "dem_tif_public": False,
        "hazard_serve_floods": False,
    })
    if entry.get("status") == "planned":
        entry["status"] = "pilot"
    counts = defaultdict(int)
    for v in status.values():
        counts[v] += 1
    return {"barangays": len(brgy_names), **counts, "unmatched": [n for n, v in status.items() if v == "none"]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="negros-occidental")
    ap.add_argument("--place", action="append")
    ap.add_argument("--force", action="store_true", help="reconfigure places that already have settings")
    args = ap.parse_args()
    from shapely.geometry import shape

    reg = load_region(args.region)
    psa = psa_barangays(reg["province"])
    osm = json.loads(OSM_BOUNDS.read_text(encoding="utf-8"))["features"]
    lgu_feats = [f for f in osm if f["properties"]["admin_level"] in (6, 7)]
    osm_brgys = [f for f in osm if f["properties"]["admin_level"] == 10]
    ov_pts, ov_areas = overture_divisions()
    report: dict[str, Any] = {}
    for entry in reg["places"]:
        if args.place and entry["slug"] not in args.place:
            continue
        if entry.get("bbox") and not args.force:
            continue
        if entry.get("trafficsim_state_dir"):
            continue  # Bacolod: hand-configured, calibrated
        cands = [f for f in lgu_feats if lgu_key(f["properties"]["name"]) == lgu_key(entry["name"])]
        if not cands:
            report[entry["slug"]] = {"error": "no OSM outline with this name"}
            continue
        best = max(cands, key=lambda f: shape(f["geometry"]).area)
        outline = shape(best["geometry"]).buffer(0)
        entry["osm_relation"] = int(best["properties"]["osm_relation"])
        entry["overture_locality"] = entry["name"]
        report[entry["slug"]] = configure(entry, outline, psa.get(entry["psa_name"], []), osm_brgys, ov_pts, ov_areas)
    (REGIONS_DIR / f"{args.region}.json").write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (REPO_ROOT / "build").mkdir(exist_ok=True)
    (REPO_ROOT / "build" / "configure_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    tot = defaultdict(int)
    for slug, r in report.items():
        if "error" in r:
            print(f"{slug:<20} ERROR {r['error']}")
            continue
        for k in ("barangays", "overture", "osm", "point", "none"):
            tot[k] += r.get(k, 0)
        print(f"{slug:<20} {r['barangays']:>3} barangays: outline Overture {r.get('overture', 0):>3}, OSM {r.get('osm', 0):>3}, "
              f"point only {r.get('point', 0):>3}, nothing {r.get('none', 0):>3}")
    print(f"TOTAL {dict(tot)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
