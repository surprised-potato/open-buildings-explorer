"""Manual boundary correction: Overture/OSM leave a ~4 km2 sliver of northern Bacolod unassigned.
That land is Barangay Bata, so merge it into Bata's polygon in boundaries.geojson.

Idempotent: once merged, no unassigned piece touches Bata and the script exits unchanged.
Rerun data:analytics, data:zonal and data:landcover after changing boundaries.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

BOUNDARIES = Path(__file__).resolve().parents[1] / "public" / "data" / "bacolod" / "boundaries.geojson"
# Unassigned land pieces smaller than this stay as they are (slivers between neighbours).
MIN_GAP_KM2 = 1.0
# Open-sea / strait remainder of the city polygon is far larger than any land gap.
MAX_GAP_KM2 = 20.0
KM2_PER_DEG2 = 111.32 * 110.57 * 0.9847  # at ~10.7 N


def merge_gap_into_bata(fc: dict) -> dict | None:
    feats = fc["features"]
    city = next(f for f in feats if f["properties"]["level"] == "city")
    brgys = [f for f in feats if f["properties"]["level"] == "barangay"]
    bata = next(f for f in brgys if f["properties"]["name"] == "Bata")
    covered = unary_union([shape(f["geometry"]).buffer(0) for f in brgys])
    gap = shape(city["geometry"]).buffer(0).difference(covered)
    pieces = list(gap.geoms) if hasattr(gap, "geoms") else [gap]
    bata_geom = shape(bata["geometry"]).buffer(0)
    take = [
        p for p in pieces
        if MIN_GAP_KM2 < p.area * KM2_PER_DEG2 < MAX_GAP_KM2 and p.distance(bata_geom) < 1e-9
    ]
    if not take:
        return None
    merged = unary_union([bata_geom, *[p.buffer(1e-7) for p in take]]).buffer(1e-7).buffer(-1e-7)
    if merged.geom_type != "Polygon":
        merged = max(merged.geoms, key=lambda g: g.area)
    merged = merged.simplify(1e-6)
    minx, miny, maxx, maxy = merged.bounds
    c = merged.centroid
    bata["geometry"] = mapping(merged)
    props = bata["properties"]
    props["centroid_lon"], props["centroid_lat"] = round(c.x, 6), round(c.y, 6)
    props["bbox"] = [round(v, 6) for v in (minx, miny, maxx, maxy)]
    props["area_km2"] = round(merged.area * KM2_PER_DEG2, 3)
    return {"pieces": len(take), "area_km2": props["area_km2"]}


def main() -> int:
    fc = json.loads(BOUNDARIES.read_text(encoding="utf-8"))
    res = merge_gap_into_bata(fc)
    if res is None:
        print("Nothing to merge (already applied).")
        return 0
    BOUNDARIES.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"Merged {res['pieces']} unassigned piece(s) into Bata; Bata is now ~{res['area_km2']} km2.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
