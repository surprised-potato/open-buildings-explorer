"""Download the province's elevation and land-cover rasters once (clipped, so only the needed part).

  data/dem/copernicus_glo30_<region>.tif          Copernicus DEM GLO-30 (30 m), Float32, region bbox
  data/landcover/worldcover_2021_<region>.tif      ESA WorldCover 10 m 2021 v200, Byte, region bbox

fetch_dem.py and compute_landcover_stats.py use these files when they exist instead of reading tiles over
the network per LGU. Sources are public cloud-optimised GeoTIFFs on AWS (no account needed).
Licences: Copernicus DEM (free and open, credit ESA / Copernicus); WorldCover CC BY 4.0 (ESA / VITO).
Run: uv run python scripts/fetch_region_rasters.py
"""
from __future__ import annotations

import argparse
import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, load_region  # noqa: E402

WORLDCOVER = "/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"


def dem_tiles(bbox: tuple[float, float, float, float]) -> list[str]:
    w, s, e, n = bbox
    out = []
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            t = f"Copernicus_DSM_COG_10_{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00_{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00_DEM"
            out.append(f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{t}/{t}.tif")
    return out


def worldcover_tiles(bbox: tuple[float, float, float, float]) -> list[str]:
    w, s, e, n = bbox
    out = []
    for lat in range(3 * math.floor(s / 3), 3 * math.floor(n / 3) + 1, 3):
        for lon in range(3 * math.floor(w / 3), 3 * math.floor(e / 3) + 1, 3):
            tile = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
            out.append(WORLDCOVER.format(tile=tile))
    return out


def exists(url: str) -> bool:
    return subprocess.run(["gdalinfo", url], capture_output=True).returncode == 0


def warp(sources: list[str], bbox, dest: Path, ot: str, nodata: str, resampling: str) -> None:
    w, s, e, n = bbox
    tmp = dest.with_suffix(".part.tif")
    cmd = ["gdalwarp", "-overwrite", "-te", str(w), str(s), str(e), str(n), "-ot", ot, "-r", resampling,
           "-dstnodata", nodata, "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER",
           "--config", "GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR", *sources, str(tmp)]
    subprocess.run(cmd, check=True, capture_output=True)
    tmp.replace(dest)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="negros-occidental")
    ap.add_argument("--place", default=None, help="ignored; accepted so the pipeline can pass it")
    args = ap.parse_args()
    bbox = tuple(load_region(args.region)["bbox"])

    dem = REPO_ROOT / "data" / "dem" / f"copernicus_glo30_{args.region}.tif"
    lc = REPO_ROOT / "data" / "landcover" / f"worldcover_2021_{args.region}.tif"
    for dest, tiles, ot, nodata, rs in (
        (dem, dem_tiles(bbox), "Float32", "-9999", "bilinear"),
        (lc, worldcover_tiles(bbox), "Byte", "0", "near"),
    ):
        if dest.exists():
            print(f"{dest.name}: already downloaded ({dest.stat().st_size / 1e6:.0f} MB)")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        present = [t for t in tiles if exists(t)]  # ocean-only tiles do not exist
        print(f"{dest.name}: clipping {len(present)} of {len(tiles)} tiles ...", flush=True)
        warp(present, bbox, dest, ot, nodata, rs)
        print(f"{dest.name}: {dest.stat().st_size / 1e6:.0f} MB in {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
