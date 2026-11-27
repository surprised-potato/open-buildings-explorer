#!/usr/bin/env python3
"""Land-cover composition per barangay from ESA WorldCover 10 m (2021, v200).

Input : data/landcover/worldcover_2021_bacolod.tif (clip of ESA WorldCover; CC BY 4.0), boundaries.geojson
Output: public/data/bacolod/barangay_landcover.json and, merged idempotently, tree_cover_pct /
        built_up_pct / cropland_pct into barangay_analytics.json rows and boundaries.geojson properties.

Why this matters: OSM-tagged parks give a city-wide "green space" of about 0.5%, while canopy seen from
above is far higher. Land cover does NOT classify buildings (checked: unknown buildings sit under tree
cover more often than houses do, but that does not tell us what they are).
Rerun after compute_barangay_analytics.py, like parse_bir_zonal_values.py.
Run with `uv run python -I scripts/compute_landcover_stats.py`.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = PLACE.out_dir
TIF = REPO_ROOT / PLACE.setting("landcover_tif", f"data/landcover/worldcover_2021_{PLACE.slug}.tif")

CLASSES: dict[int, str] = {
    10: "tree_cover", 20: "shrubland", 30: "grassland", 40: "cropland", 50: "built_up",
    60: "bare", 70: "snow_ice", 80: "water", 90: "wetland", 95: "mangrove", 100: "moss_lichen",
}


def shares(values: np.ndarray) -> dict[str, float]:
    """Percent of cells per WorldCover class (classes absent are omitted); sums to 100 for valid cells."""
    v = values[values > 0]
    if v.size == 0:
        return {}
    out: dict[str, float] = {}
    for code, name in CLASSES.items():
        n = int((v == code).sum())
        if n:
            out[name] = round(100.0 * n / v.size, 2)
    return out


def read_raster(tif: Path) -> tuple[np.ndarray, float, float, float]:
    """(uint8 array[row, col], west, north, cell size) through GDAL's ENVI raw output."""
    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_lc_") as d:
        raw = Path(d) / "lc.bin"
        subprocess.run(["gdal_translate", "-q", "-of", "ENVI", str(tif), str(raw)], check=True)
        hdr = (Path(d) / "lc.hdr").read_text()
        info = dict(
            (k.strip(), v.strip()) for k, v in (line.split("=", 1) for line in hdr.splitlines() if "=" in line)
        )
        ncols, nrows = int(info["samples"]), int(info["lines"])
        arr = np.fromfile(raw, dtype=np.uint8).reshape(nrows, ncols)
        mapinfo = [p.strip() for p in info["map info"].strip("{}").split(",")]
        west, north, cs = float(mapinfo[3]), float(mapinfo[4]), float(mapinfo[5])
    return arr, west, north, cs


def per_barangay(arr: np.ndarray, west: float, north: float, cs: float, polys: list[tuple[str, Any]]) -> dict[str, dict[str, float]]:
    import shapely

    out: dict[str, dict[str, float]] = {}
    nrows, ncols = arr.shape
    for name, poly in polys:
        x0, y0, x1, y1 = poly.bounds
        c0, c1 = max(0, int((x0 - west) // cs)), min(ncols, int((x1 - west) // cs) + 1)
        r0, r1 = max(0, int((north - y1) // cs)), min(nrows, int((north - y0) // cs) + 1)
        if c1 <= c0 or r1 <= r0:
            continue
        xs = west + (np.arange(c0, c1) + 0.5) * cs
        ys = north - (np.arange(r0, r1) + 0.5) * cs
        gx, gy = np.meshgrid(xs, ys)
        mask = shapely.contains_xy(poly, gx, gy)
        out[name] = shares(arr[r0:r1, c0:c1][mask])
    return out


def enrich(analytics_path: Path, boundaries_path: Path, lc: dict[str, dict[str, float]]) -> None:
    def fields(rec: dict[str, float]) -> dict[str, float]:
        return {
            "tree_cover_pct": rec.get("tree_cover", 0.0),
            "built_up_pct": rec.get("built_up", 0.0),
            "cropland_pct": rec.get("cropland", 0.0),
        }

    if analytics_path.exists():
        an = json.loads(analytics_path.read_text(encoding="utf-8"))
        for row in an.get("barangays", []):
            rec = lc.get(row.get("name"))
            if rec is not None:
                row.update(fields(rec))
        analytics_path.write_text(json.dumps(an, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    if boundaries_path.exists():
        fc = json.loads(boundaries_path.read_text(encoding="utf-8"))
        for feat in fc.get("features", []):
            props = feat.get("properties") or {}
            rec = lc.get(str(props.get("name")))
            if props.get("level") == "barangay" and rec is not None:
                props.update(fields(rec))
        boundaries_path.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--tif", type=Path, default=TIF)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    from shapely.geometry import shape

    fc = json.loads((args.out_dir / "boundaries.geojson").read_text(encoding="utf-8"))
    polys = [(f["properties"]["name"], shape(f["geometry"])) for f in fc["features"] if f["properties"].get("level") == "barangay"]
    arr, west, north, cs = read_raster(args.tif)
    lc = per_barangay(arr, west, north, cs, polys)
    payload = {
        "source": "ESA WorldCover 10 m 2021 v200 (CC BY 4.0, ESA / VITO)",
        "classes": {str(k): v for k, v in CLASSES.items()},
        "note": "Share of 10 m cells by land-cover class inside each barangay. A satellite view of the surface, not a land-use map.",
        "barangays": lc,
    }
    (args.out_dir / "barangay_landcover.json").write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    enrich(args.out_dir / "barangay_analytics.json", args.out_dir / "boundaries.geojson", lc)
    tree = sorted(((r.get("tree_cover", 0.0), n) for n, r in lc.items()), reverse=True)
    print(f"{len(lc)} barangays; tree cover {tree[-1][0]:.0f}% ({tree[-1][1]}) to {tree[0][0]:.0f}% ({tree[0][1]})")


if __name__ == "__main__":
    sys.exit(main())
