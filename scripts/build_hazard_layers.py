#!/usr/bin/env python3
"""Clip Project NOAH flood and storm-surge hazard maps to Bacolod City.

Inputs : data/noah/{flood_5yr,flood_25yr,flood_100yr,surge_ssa1..4}_NegrosOccidental.zip
         (Project NOAH, UP Resilience Institute; ESRI shapefiles per province, EPSG:4326)
Output : public/data/bacolod/hazards.geojson  (one feature per hazard and level)

Hazard levels (NOAH, attribute Var): 1 low (0-0.5 m), 2 medium (0.5-1.5 m), 3 high (>1.5 m) for floods.
Storm surge advisories SSA1-4 are surge height bands (2-3 m, 3-4 m, 4-5 m, >5 m); each file is the area
reached at that level, stored here as level 1 so "reached by SSAn" is a simple yes/no.
Licence: Open Data Commons ODbL. Derived data must stay under ODbL and credit Project NOAH.
Run with `uv run python -I scripts/build_hazard_layers.py` (the shapefiles are untrusted input).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parents[1]
IN_DIR = REPO_ROOT / "data" / "noah"
NOAH_PROVINCE = PLACE.setting("noah_province", "NegrosOccidental")
OUT = PLACE.out_dir / "hazards.geojson"
BOUNDARIES = PLACE.out_dir / "boundaries.geojson"
MIN_CITY_KM2 = 0.01  # a hazard with less area than this inside the city is treated as not covering it
BBOX = PLACE.analysis_bbox  # west, south, east, north: the place plus a margin
SIMPLIFY_DEG = 2e-5  # about 2 m, far below the hazard model's own accuracy

HAZARDS: list[dict[str, Any]] = [
    {"key": "flood_5yr", "label": "Flood, 5-year rain", "zip": f"flood_5yr_{NOAH_PROVINCE}.zip", "levels": {1: "Low", 2: "Medium", 3: "High"}},
    {"key": "flood_25yr", "label": "Flood, 25-year rain", "zip": f"flood_25yr_{NOAH_PROVINCE}.zip", "levels": {1: "Low", 2: "Medium", 3: "High"}},
    {"key": "flood_100yr", "label": "Flood, 100-year rain", "zip": f"flood_100yr_{NOAH_PROVINCE}.zip", "levels": {1: "Low", 2: "Medium", 3: "High"}},
    {"key": "surge_ssa1", "label": "Storm surge 2-3 m", "zip": f"surge_ssa1_{NOAH_PROVINCE}.zip", "levels": {1: "Reached"}},
    {"key": "surge_ssa2", "label": "Storm surge 3-4 m", "zip": f"surge_ssa2_{NOAH_PROVINCE}.zip", "levels": {1: "Reached"}},
    {"key": "surge_ssa3", "label": "Storm surge 4-5 m", "zip": f"surge_ssa3_{NOAH_PROVINCE}.zip", "levels": {1: "Reached"}},
    {"key": "surge_ssa4", "label": "Storm surge over 5 m", "zip": f"surge_ssa4_{NOAH_PROVINCE}.zip", "levels": {1: "Reached"}},
]


def level_of(props: dict[str, Any], is_surge: bool) -> int | None:
    """Hazard level from a NOAH feature's attributes (Var), or 1 for surge files without one."""
    if is_surge:
        return 1
    v = props.get("Var")
    try:
        lv = int(round(float(v)))
    except (TypeError, ValueError):
        return None
    return lv if lv in (1, 2, 3) else None


def clip_shapefile(shp: Path, tmp: Path) -> list[dict[str, Any]]:
    out = tmp / f"{shp.stem}_clip.geojsonl"
    subprocess.run(
        [
            "ogr2ogr", "-f", "GeoJSONSeq", "-clipsrc", *[str(v) for v in BBOX],
            "-makevalid", "-nlt", "PROMOTE_TO_MULTI", str(out), str(shp),
        ],
        check=True,
    )
    feats = []
    with out.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                feats.append(json.loads(line))
    return feats


def city_polygon(path: Path) -> Any:
    from shapely.geometry import shape
    from shapely.ops import unary_union

    fc = json.loads(path.read_text(encoding="utf-8"))
    return unary_union([shape(f["geometry"]) for f in fc["features"] if f["properties"].get("level") == "barangay"])


def km2(area_deg2: float, lat: float = PLACE.lat0) -> float:
    import math

    return area_deg2 * 111.32**2 * math.cos(math.radians(lat))


def build(in_dir: Path, boundaries: Path = BOUNDARIES) -> dict[str, Any]:
    from shapely.geometry import mapping, shape

    city = city_polygon(boundaries) if boundaries.exists() else None
    dropped: list[dict[str, Any]] = []

    features: list[dict[str, Any]] = []
    meta: list[dict[str, Any]] = []
    for h in HAZARDS:
        zpath = in_dir / h["zip"]
        if not zpath.exists():
            print(f"missing {zpath.name}, skipped")
            continue
        is_surge = h["key"].startswith("surge")
        with tempfile.TemporaryDirectory(prefix="noah_") as d:
            tmp = Path(d)
            with zipfile.ZipFile(zpath) as z:
                z.extractall(tmp)
            shp = next(tmp.glob("*.shp"))
            feats = clip_shapefile(shp, tmp)
        by_level: dict[int, list[Any]] = {}
        for f in feats:
            lv = level_of(f.get("properties") or {}, is_surge)
            if lv is None or not f.get("geometry"):
                continue
            by_level.setdefault(lv, []).append(shape(f["geometry"]))
        from shapely.ops import unary_union

        merged = {lv: unary_union(geoms).simplify(SIMPLIFY_DEG, preserve_topology=True) for lv, geoms in sorted(by_level.items())}
        inside = sum(km2(g.intersection(city).area) for g in merged.values()) if city is not None else None
        if inside is not None and inside < MIN_CITY_KM2:
            dropped.append({"key": h["key"], "reason": f"no mapped hazard area inside {PLACE.display_name}", "city_km2": round(inside, 3)})
            print(f"{h['key']}: {inside:.3f} km2 inside the city, dropped (not covered by NOAH here)")
            continue
        for lv, g in merged.items():
            if g.is_empty:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {"hazard": h["key"], "level": lv, "label": h["levels"].get(lv, str(lv))},
                    "geometry": mapping(g),
                }
            )
        meta.append(
            {
                "key": h["key"],
                "label": h["label"],
                "levels": {str(k): v for k, v in h["levels"].items()},
                "city_km2": round(inside, 2) if inside is not None else None,
            }
        )
        print(f"{h['key']}: levels {sorted(by_level)}")
    return {
        "type": "FeatureCollection",
        "name": f"{PLACE.file_prefix}_hazards",
        "meta": {
            "source": "Project NOAH, UP Resilience Institute (noah.up.edu.ph)",
            "licence": "Open Data Commons ODbL 1.0; attribute Project NOAH and its contributors",
            "bbox": list(BBOX),
            "hazards": meta,
            "dropped": dropped,
            "note": "Modelled hazard, not a record of floods. Flood levels: low 0-0.5 m, medium 0.5-1.5 m, high >1.5 m.",
        },
        "features": features,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--in-dir", type=Path, default=IN_DIR)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--boundaries", type=Path, default=BOUNDARIES)
    args = ap.parse_args()
    fc = build(args.in_dir, args.boundaries)
    args.out.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(fc['features'])} features, {args.out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
