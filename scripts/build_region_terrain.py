"""Province-wide 3D terrain tiles and elevation contours, shared by every LGU (instead of one overlapping
copy per LGU, which tripled their size).

Input : data/dem/copernicus_glo30_<region>.tif (fetch_region_rasters.py)
Output: public/data/_region/terrarium/{z}/{x}/{y}.png   Terrarium tiles, z10-13, region land extent
        public/data/_region/contours.pmtiles            20 m contours, 100 m index lines
        public/data/_region/terrain.json                what fetch_dem.py writes into each place's dem_manifest
Places with "shared_terrain": true in the registry point at these files.
Run: uv run python scripts/build_region_terrain.py
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, load_region  # noqa: E402

INTERVAL, MAJOR = 20, 100


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="negros-occidental")
    ap.add_argument("--place", default=None, help="ignored; accepted so the pipeline can pass it")
    args = ap.parse_args()
    import fetch_dem  # its tile and contour builders (module constants default to Bacolod; unused here)

    reg = load_region(args.region)
    bbox = tuple(reg["bbox"])
    dem = REPO_ROOT / "data" / "dem" / f"copernicus_glo30_{args.region}.tif"
    if not dem.exists():
        raise SystemExit(f"{dem} missing: run fetch_region_rasters.py")
    out = REPO_ROOT / "public" / "data" / "_region"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="region_terrain_") as tmp:
        tmp_dir = Path(tmp)
        print("Terrarium tiles z10-13 ...", flush=True)
        tiles = fetch_dem.build_terrarium_tiles(dem, out / "terrarium", tmp_dir, bbox=bbox)
        print(f"  {tiles} tiles", flush=True)
        print(f"Contours every {INTERVAL} m ...", flush=True)
        n = fetch_dem.build_contours(dem, out / "contours.pmtiles", tmp_dir, interval=INTERVAL, major=MAJOR)
        print(f"  {n} contour lines", flush=True)
    meta = {
        "source": "Copernicus DEM GLO-30 (30m), province mosaic",
        "contours": {"file": "data/_region/contours.pmtiles", "interval_m": INTERVAL, "major_interval_m": MAJOR,
                     "feature_count": n},
        "terrarium": {"tiles_template": "data/_region/terrarium/{z}/{x}/{y}.png", "minzoom": 10, "maxzoom": 13,
                      "bounds": list(bbox), "tile_count": tiles},
    }
    (out / "terrain.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file()) / 1e6
    print(f"Shared terrain for {args.region}: {size:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
