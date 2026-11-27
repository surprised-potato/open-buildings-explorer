"""Apply hand corrections from overrides/<place>/boundaries.json to boundaries.geojson.

Supported rules
  assign_unassigned: [{to, min_km2, max_km2, note}]
      Land inside the place boundary that no barangay covers is merged into barangay `to`
      when a piece touches it and its area is within [min_km2, max_km2]. The upper bound keeps
      open sea inside a coastal city polygon out of the barangay.

Idempotent: once applied, there is nothing left to merge and the file is unchanged.
Rerun data:analytics, data:zonal and data:landcover after boundaries change.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()
BOUNDARIES = PLACE.out_dir / "boundaries.geojson"
OVERRIDES = PLACE.overrides_dir() / "boundaries.json"


def km2_per_deg2(lat: float) -> float:
    import math

    return 111.32 * 110.57 * math.cos(math.radians(lat))


def unassigned_pieces(fc: dict[str, Any]) -> list[Any]:
    feats = fc["features"]
    city = next(f for f in feats if f["properties"]["level"] == "city")
    brgys = [f for f in feats if f["properties"]["level"] == "barangay"]
    covered = unary_union([shape(f["geometry"]).buffer(0) for f in brgys])
    gap = shape(city["geometry"]).buffer(0).difference(covered)
    return list(gap.geoms) if hasattr(gap, "geoms") else ([] if gap.is_empty else [gap])


def merge_gap_into(fc: dict[str, Any], target: str, min_km2: float, max_km2: float, lat: float = 10.7) -> dict | None:
    """Merge unassigned pieces touching barangay `target` into it. Returns a summary or None."""
    k = km2_per_deg2(lat)
    brgys = [f for f in fc["features"] if f["properties"]["level"] == "barangay"]
    feat = next((f for f in brgys if f["properties"]["name"] == target), None)
    if feat is None:
        raise SystemExit(f"Override names barangay '{target}', which is not in boundaries.geojson")
    geom = shape(feat["geometry"]).buffer(0)
    take = [p for p in unassigned_pieces(fc) if min_km2 < p.area * k < max_km2 and p.distance(geom) < 1e-9]
    if not take:
        return None
    merged = unary_union([geom, *[p.buffer(1e-7) for p in take]]).buffer(1e-7).buffer(-1e-7)
    if merged.geom_type != "Polygon":
        merged = max(merged.geoms, key=lambda g: g.area)
    merged = merged.simplify(1e-6)
    minx, miny, maxx, maxy = merged.bounds
    c = merged.centroid
    feat["geometry"] = mapping(merged)
    props = feat["properties"]
    props["centroid_lon"], props["centroid_lat"] = round(c.x, 6), round(c.y, 6)
    props["bbox"] = [round(v, 6) for v in (minx, miny, maxx, maxy)]
    props["area_km2"] = round(merged.area * k, 3)
    return {"to": target, "pieces": len(take), "area_km2": props["area_km2"]}


def apply_overrides(fc: dict[str, Any], rules: dict[str, Any], lat: float) -> list[dict]:
    done = []
    for rule in rules.get("assign_unassigned", []):
        res = merge_gap_into(fc, rule["to"], float(rule.get("min_km2", 1.0)), float(rule.get("max_km2", 20.0)), lat)
        if res:
            done.append(res)
    return done


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--boundaries", type=Path, default=BOUNDARIES)
    ap.add_argument("--overrides", type=Path, default=OVERRIDES)
    args = ap.parse_args()
    if not args.overrides.exists():
        print(f"No boundary overrides for {PLACE.slug}.")
        return 0
    fc = json.loads(args.boundaries.read_text(encoding="utf-8"))
    done = apply_overrides(fc, json.loads(args.overrides.read_text(encoding="utf-8")), PLACE.lat0)
    if not done:
        print("Boundary overrides already applied; nothing to change.")
        return 0
    args.boundaries.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    for d in done:
        print(f"Merged {d['pieces']} unassigned piece(s) into {d['to']}; now ~{d['area_km2']} km2.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
