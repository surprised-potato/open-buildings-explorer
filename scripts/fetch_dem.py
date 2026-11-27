#!/usr/bin/env python3
"""Fetch and compile the local Copernicus GLO-30 DEM suite for Bacolod City.

Produces static raster/vector DEM assets in public/data/bacolod/dem/:
  - bacolod_dem.tif                Master clipped Float32 DEM (EPSG:4326)
  - terrarium/{z}/{x}/{y}.png      Local Mapzen Terrarium 3D terrain tiles (z10-z13)
  - bacolod_elevation_relief.png   EPSG:3857 hypsometric elevation color-relief
  - bacolod_slope.png              EPSG:3857 terrain slope (computed in UTM 51N)
  - bacolod_contours.pmtiles       5m / 25m elevation contours vector tiles
  - bacolod_dem_grid.bin           486x324 Int16 decimeter grid for offline sampling
  - dem_manifest.json              Metadata, bounds, exact overlay corners, and stats

Optionally pass --tif <path> to ingest a custom local DEM (e.g., NAMRIA 5m IfSAR
or Phil-LiDAR 1m DTM) instead of streaming Copernicus GLO-30.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "data" / "bacolod" / "dem"

# Padded Bacolod City bounding box (west, south, east, north)
BACOLOD_BBOX = (122.88, 10.57, 123.15, 10.75)
# Slightly wider terrain mesh bbox so eastern foothills render seamlessly
TERRAIN_BBOX = (122.85, 10.54, 123.20, 10.78)

COPERNICUS_URLS = [
    "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N10_00_E122_00_DEM/Copernicus_DSM_COG_10_N10_00_E122_00_DEM.tif",
    "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N10_00_E123_00_DEM/Copernicus_DSM_COG_10_N10_00_E123_00_DEM.tif",
]

ORIGIN_SHIFT = 20037508.342789244  # Web Mercator half-circumference (meters)
GRID_WIDTH = 486
GRID_HEIGHT = 324
NODATA_F32 = -9999.0
NODATA_I16 = -32768


def run_cmd(cmd: list[str]) -> str:
    """Run a subprocess command and raise with stderr on failure."""
    res = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(
            f"Command failed ({res.returncode}): {' '.join(cmd)}\n{res.stderr.strip()}"
        )
    return res.stdout


def lonlat_to_tile(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    """Convert WGS84 lon/lat to slippy-map XYZ tile coordinates."""
    lat_rad = math.radians(max(-85.0511, min(85.0511, lat)))
    n = 2**zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def mercator_to_lonlat(mx: float, my: float) -> tuple[float, float]:
    """Convert EPSG:3857 meters to WGS84 (lon, lat)."""
    lon = (mx / ORIGIN_SHIFT) * 180.0
    lat = (my / ORIGIN_SHIFT) * 180.0
    lat = 180.0 / math.pi * (2.0 * math.atan(math.exp(lat * math.pi / 180.0)) - math.pi / 2.0)
    return lon, lat


def get_3857_wgs84_corners(tif_3857: Path) -> list[list[float]]:
    """Read exact EPSG:3857 raster extent via gdalinfo and return MapLibre 4-corner WGS84 coords."""
    info = json.loads(run_cmd(["gdalinfo", "-json", str(tif_3857)]))
    gt = info["geoTransform"]
    w, h = info["size"]
    xmin = gt[0]
    ymax = gt[3]
    xmax = xmin + w * gt[1]
    ymin = ymax + h * gt[5]
    tl = list(mercator_to_lonlat(xmin, ymax))
    tr = list(mercator_to_lonlat(xmax, ymax))
    br = list(mercator_to_lonlat(xmax, ymin))
    bl = list(mercator_to_lonlat(xmin, ymin))
    return [tl, tr, br, bl]


def write_color_table(path: Path, entries: Iterable[str]) -> None:
    """Write a GDAL color-relief table file."""
    path.write_text("\n".join(entries) + "\n", encoding="utf-8")


def encode_terrarium_png(elev: np.ndarray, out_png: Path) -> None:
    """Encode a 256x256 float32 elevation tile into a Mapzen Terrarium RGB PNG."""
    clean = np.where((elev == NODATA_F32) | ~np.isfinite(elev) | (elev < 0.0), 0.0, elev)
    v = np.clip(clean + 32768.0, 0.0, 65535.996)
    r = np.floor(v / 256.0).astype(np.uint8)
    g = (np.floor(v).astype(np.int32) % 256).astype(np.uint8)
    b = np.floor((v - np.floor(v)) * 256.0).astype(np.uint8)
    rgb = np.stack([r, g, b], axis=-1)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, mode="RGB").save(out_png, format="PNG", optimize=True)


def build_terrarium_tiles(terrain_dem: Path, out_tiles_dir: Path, tmp_dir: Path) -> int:
    """Generate local Terrarium PNG tiles across zooms 10-13 for TERRAIN_BBOX."""
    if out_tiles_dir.exists():
        shutil.rmtree(out_tiles_dir)
    out_tiles_dir.mkdir(parents=True, exist_ok=True)

    west, south, east, north = TERRAIN_BBOX
    tile_count = 0

    for z in range(10, 14):
        x_min, y_min = lonlat_to_tile(west, north, z)
        x_max, y_max = lonlat_to_tile(east, south, z)
        nx = x_max - x_min + 1
        ny = y_max - y_min + 1
        tile_span = (2.0 * ORIGIN_SHIFT) / (2**z)

        mx_min = -ORIGIN_SHIFT + x_min * tile_span
        mx_max = -ORIGIN_SHIFT + (x_max + 1) * tile_span
        my_max = ORIGIN_SHIFT - y_min * tile_span
        my_min = ORIGIN_SHIFT - (y_max + 1) * tile_span

        width = nx * 256
        height = ny * 256
        bin_path = tmp_dir / f"terrarium_z{z}.bin"

        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:3857",
            "-te", str(mx_min), str(my_min), str(mx_max), str(my_max),
            "-ts", str(width), str(height),
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            "-of", "ENVI",
            str(terrain_dem),
            str(bin_path),
        ])

        arr = np.fromfile(bin_path, dtype=np.float32).reshape((height, width))
        for ty in range(y_min, y_max + 1):
            r0 = (ty - y_min) * 256
            for tx in range(x_min, x_max + 1):
                c0 = (tx - x_min) * 256
                tile_arr = arr[r0 : r0 + 256, c0 : c0 + 256]
                encode_terrarium_png(tile_arr, out_tiles_dir / str(z) / str(tx) / f"{ty}.png")
                tile_count += 1

    return tile_count


def build_contours(master_dem: Path, out_pmtiles: Path, tmp_dir: Path) -> int:
    """Extract 5m contours (25m major) and compile to vector PMTiles."""
    raw_geojson = tmp_dir / "contours_raw.geojson"
    filtered_geojson = tmp_dir / "contours_filtered.geojson"

    run_cmd([
        "gdal_contour",
        "-a", "elev_m",
        "-i", "5",
        "-f", "GeoJSON",
        str(master_dem),
        str(raw_geojson),
    ])

    raw_fc = json.loads(raw_geojson.read_text(encoding="utf-8"))
    kept: list[dict] = []
    for idx, feat in enumerate(raw_fc.get("features", [])):
        props = feat.get("properties") or {}
        elev = props.get("elev_m")
        if elev is None or float(elev) <= 0.0:
            continue
        elev_int = int(round(float(elev)))
        kept.append({
            "type": "Feature",
            "properties": {
                "id": f"c-{elev_int}-{idx}",
                "elev_m": elev_int,
                "is_major": 1 if elev_int % 25 == 0 else 0,
                "label": f"{elev_int} m",
            },
            "geometry": feat["geometry"],
        })

    filtered_fc = {"type": "FeatureCollection", "features": kept}
    filtered_geojson.write_text(json.dumps(filtered_fc), encoding="utf-8")

    if out_pmtiles.exists():
        out_pmtiles.unlink()

    run_cmd([
        "ogr2ogr",
        "-f", "PMTiles",
        "-nln", "contours",
        "-dsco", "MINZOOM=11",
        "-dsco", "MAXZOOM=16",
        "-t_srs", "EPSG:4326",
        str(out_pmtiles),
        str(filtered_geojson),
    ])
    return len(kept)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Bacolod City DEM suite.")
    parser.add_argument(
        "--tif",
        type=Path,
        default=None,
        help="Optional local GeoTIFF DEM (e.g. NAMRIA 5m IfSAR / Phil-LiDAR 1m DTM).",
    )
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sources = [str(args.tif.resolve())] if args.tif else COPERNICUS_URLS
    source_label = args.tif.name if args.tif else "Copernicus DEM GLO-30 (30m)"
    resolution_m = 5 if args.tif else 30

    with tempfile.TemporaryDirectory(prefix="bacolod_dem_") as tmp:
        tmp_dir = Path(tmp)
        terrain_dem = tmp_dir / "terrain_dem.tif"
        master_dem = OUT_DIR / "bacolod_dem.tif"

        print(f"1/6 Clipping DEM from {source_label}...")
        t_west, t_south, t_east, t_north = TERRAIN_BBOX
        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:4326",
            "-te", str(t_west), str(t_south), str(t_east), str(t_north),
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            *sources,
            str(terrain_dem),
        ])

        b_west, b_south, b_east, b_north = BACOLOD_BBOX
        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:4326",
            "-te", str(b_west), str(b_south), str(b_east), str(b_north),
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            "-co", "COMPRESS=LZW",
            str(terrain_dem),
            str(master_dem),
        ])

        print("2/6 Generating local Terrarium 3D terrain tiles (z10-z13)...")
        terrarium_dir = OUT_DIR / "terrarium"
        tile_count = build_terrarium_tiles(terrain_dem, terrarium_dir, tmp_dir)

        print("3/6 Building EPSG:3857 Elevation Color-Relief raster...")
        dem_3857 = tmp_dir / "dem_3857.tif"
        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:3857",
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            str(master_dem),
            str(dem_3857),
        ])
        relief_ramp = tmp_dir / "relief_ramp.txt"
        write_color_table(relief_ramp, [
            "-9999 0 0 0 0",
            "0.0 0 0 0 0",
            "0.2 14 116 144 215",
            "3.0 6 182 212 215",
            "10.0 16 185 129 215",
            "25.0 132 204 22 215",
            "75.0 234 179 8 225",
            "180.0 234 88 12 230",
            "350.0 185 28 28 235",
            "600.0 248 250 252 240",
        ])
        relief_png = OUT_DIR / "bacolod_elevation_relief.png"
        run_cmd([
            "gdaldem", "color-relief",
            str(dem_3857), str(relief_ramp), str(relief_png),
            "-of", "PNG", "-alpha",
        ])
        relief_png.with_name(relief_png.name + ".aux.xml").unlink(missing_ok=True)
        relief_coords = get_3857_wgs84_corners(dem_3857)

        print("4/6 Computing UTM Zone 51N Slope Analysis raster...")
        dem_utm = tmp_dir / "dem_utm51n.tif"
        slope_utm = tmp_dir / "slope_utm51n.tif"
        slope_3857 = tmp_dir / "slope_3857.tif"
        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:32651",
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            str(master_dem),
            str(dem_utm),
        ])
        run_cmd([
            "gdaldem", "slope",
            str(dem_utm), str(slope_utm),
            "-compute_edges",
        ])
        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:3857",
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            str(slope_utm),
            str(slope_3857),
        ])
        slope_ramp = tmp_dir / "slope_ramp.txt"
        write_color_table(slope_ramp, [
            "-9999 0 0 0 0",
            "0 15 23 42 0",
            "1 56 189 248 110",
            "3 250 204 21 175",
            "8 249 115 22 210",
            "15 225 29 72 230",
            "35 159 18 57 240",
        ])
        slope_png = OUT_DIR / "bacolod_slope.png"
        run_cmd([
            "gdaldem", "color-relief",
            str(slope_3857), str(slope_ramp), str(slope_png),
            "-of", "PNG", "-alpha",
        ])
        slope_png.with_name(slope_png.name + ".aux.xml").unlink(missing_ok=True)
        slope_coords = get_3857_wgs84_corners(slope_3857)

        print("5/6 Extracting 5m/25m contours to PMTiles...")
        contours_pmtiles = OUT_DIR / "bacolod_contours.pmtiles"
        contour_count = build_contours(master_dem, contours_pmtiles, tmp_dir)

        print("6/6 Encoding compact offline elevation grid & manifest...")
        grid_f32 = tmp_dir / "dem_grid_f32.bin"
        run_cmd([
            "gdalwarp",
            "-overwrite",
            "-t_srs", "EPSG:4326",
            "-te", str(b_west), str(b_south), str(b_east), str(b_north),
            "-ts", str(GRID_WIDTH), str(GRID_HEIGHT),
            "-r", "bilinear",
            "-ot", "Float32",
            "-dstnodata", str(NODATA_F32),
            "-of", "ENVI",
            str(master_dem),
            str(grid_f32),
        ])
        elev_f32 = np.fromfile(grid_f32, dtype=np.float32).reshape((GRID_HEIGHT, GRID_WIDTH))
        valid_mask = (elev_f32 != NODATA_F32) & np.isfinite(elev_f32)
        valid_vals = elev_f32[valid_mask]

        grid_i16 = np.full((GRID_HEIGHT, GRID_WIDTH), NODATA_I16, dtype=np.int16)
        scaled = np.rint(np.clip(elev_f32[valid_mask] * 10.0, -32767.0, 32767.0)).astype(np.int16)
        grid_i16[valid_mask] = scaled
        grid_bin = OUT_DIR / "bacolod_dem_grid.bin"
        grid_i16.astype("<i2").tofile(grid_bin)

        manifest = {
            "source": source_label,
            "resolution_m": resolution_m,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "bbox": list(BACOLOD_BBOX),
            "stats": {
                "min_m": round(float(np.min(valid_vals)), 2),
                "max_m": round(float(np.max(valid_vals)), 2),
                "mean_m": round(float(np.mean(valid_vals)), 2),
                "p50_m": round(float(np.percentile(valid_vals, 50)), 2),
                "p90_m": round(float(np.percentile(valid_vals, 90)), 2),
            },
            "grid": {
                "file": "data/bacolod/dem/bacolod_dem_grid.bin",
                "width": GRID_WIDTH,
                "height": GRID_HEIGHT,
                "bbox": list(BACOLOD_BBOX),
                "scale": 0.1,
                "nodata": NODATA_I16,
            },
            "relief": {
                "file": "data/bacolod/dem/bacolod_elevation_relief.png",
                "coordinates": relief_coords,
            },
            "slope": {
                "file": "data/bacolod/dem/bacolod_slope.png",
                "coordinates": slope_coords,
            },
            "contours": {
                "file": "data/bacolod/dem/bacolod_contours.pmtiles",
                "interval_m": 5,
                "major_interval_m": 25,
                "feature_count": contour_count,
            },
            "terrarium": {
                "tiles_template": "data/bacolod/dem/terrarium/{z}/{x}/{y}.png",
                "minzoom": 10,
                "maxzoom": 13,
                "bounds": list(TERRAIN_BBOX),
                "tile_count": tile_count,
            },
        }
        (OUT_DIR / "dem_manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )

    print("DEM suite ready:")
    print(json.dumps(manifest["stats"], indent=2))
    print(f"Terrarium tiles: {tile_count}, Contour features: {contour_count}")


if __name__ == "__main__":
    main()
