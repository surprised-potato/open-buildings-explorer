#!/usr/bin/env python3
"""Phase 2 enrichment hook: backfill estimated building heights using zonal statistics
from a Google Open Buildings 2.5D Temporal GeoTIFF (height band) and rebuild bacolod_buildings.pmtiles.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PMTILES = PLACE.pmtiles("buildings")
DEFAULT_MANIFEST = PLACE.out_dir / "manifest.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill estimated building heights from a Google Open Buildings 2.5D GeoTIFF."
    )
    parser.add_argument(
        "--tif",
        required=True,
        type=Path,
        help="Path to the Google Open Buildings 2.5D GeoTIFF (building_height band in meters).",
    )
    parser.add_argument(
        "--pmtiles",
        type=Path,
        default=DEFAULT_PMTILES,
        help=f"Buildings PMTiles file to enrich in-place (default: {DEFAULT_PMTILES}).",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help=f"Manifest JSON to update counts (default: {DEFAULT_MANIFEST}).",
    )
    parser.add_argument(
        "--band",
        type=int,
        default=1,
        help="GeoTIFF band index containing building heights in meters (default: 1).",
    )
    parser.add_argument(
        "--stat",
        choices=["median", "mean", "max"],
        default="median",
        help="Zonal statistic per building footprint (default: median).",
    )
    parser.add_argument(
        "--min-height",
        type=float,
        default=2.5,
        help="Minimum valid 2.5D building height in meters to accept (default: 2.5).",
    )
    add_place_argument(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.tif.exists():
        print(f"Error: GeoTIFF not found: {args.tif}", file=sys.stderr)
        return 1
    if not args.pmtiles.exists():
        print(f"Error: Buildings PMTiles not found: {args.pmtiles}", file=sys.stderr)
        return 1

    try:
        import rasterio
        from rasterstats import zonal_stats
        from shapely.geometry import shape
        from shapely.ops import transform
    except ImportError as exc:
        print(
            "Missing raster dependencies. Install with `uv sync --extra raster` "
            "or run with `uv run --extra raster scripts/enrich_heights_25d.py --tif ...`.\n"
            f"Details: {exc}",
            file=sys.stderr,
        )
        return 1

    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_25d_") as tmp:
        tmp_dir = Path(tmp)
        extracted_geojsonl = tmp_dir / "extracted.geojsonl"
        enriched_geojsonl = tmp_dir / "enriched.geojsonl"

        print(f"Extracting full-zoom features from {args.pmtiles}...")
        subprocess.run(
            [
                "ogr2ogr",
                "-f",
                "GeoJSONSeq",
                "-oo",
                "ZOOM_LEVEL=16",
                "-oo",
                "CLIP=NO",
                str(extracted_geojsonl),
                str(args.pmtiles),
                "buildings",
            ],
            check=True,
        )

        features = []
        estimated_indices = []
        with extracted_geojsonl.open("r", encoding="utf-8") as fh:
            for idx, line in enumerate(fh):
                line = line.strip()
                if not line:
                    continue
                feat = json.loads(line)
                features.append(feat)
                if feat.get("properties", {}).get("height_source") == "estimated":
                    estimated_indices.append(idx)

        print(f"Loaded {len(features)} buildings ({len(estimated_indices)} estimated).")

        with rasterio.open(args.tif) as src:
            raster_crs = src.crs
            nodata = src.nodata

            reproject_fn = None
            if raster_crs and raster_crs.to_epsg() != 4326:
                from pyproj import Transformer

                transformer = Transformer.from_crs("EPSG:4326", raster_crs, always_xy=True)
                reproject_fn = transformer.transform

            geoms_for_stats = []
            for idx in estimated_indices:
                geom = shape(features[idx]["geometry"])
                if reproject_fn is not None:
                    geom = transform(reproject_fn, geom)
                geoms_for_stats.append(geom)

            stats = zonal_stats(
                geoms_for_stats,
                str(args.tif),
                band=args.band,
                stats=[args.stat],
                nodata=nodata,
                all_touched=True,
            )

        updated = 0
        for idx, stat_res in zip(estimated_indices, stats):
            val = stat_res.get(args.stat)
            if val is not None and math.isfinite(val) and float(val) >= args.min_height:
                h = round(float(val), 1)
                props = features[idx]["properties"]
                props["height"] = h
                props["effective_height"] = h
                props["height_source"] = "measured"
                props["primary_source"] = "Google Open Buildings 2.5D"
                updated += 1

        print(f"Backfilled {updated} estimated buildings from 2.5D GeoTIFF.")

        counts = {"measured": 0, "floors": 0, "estimated": 0}
        with enriched_geojsonl.open("w", encoding="utf-8") as fh:
            for feat in features:
                src_tag = feat.get("properties", {}).get("height_source", "estimated")
                counts[src_tag] = counts.get(src_tag, 0) + 1
                fh.write(json.dumps(feat, separators=(",", ":")) + "\n")

        temp_pmtiles = tmp_dir / f"{PLACE.file_prefix}_buildings.pmtiles"
        subprocess.run(
            [
                "ogr2ogr",
                "-f",
                "PMTiles",
                "-nln",
                "buildings",
                "-dsco",
                "MINZOOM=11",
                "-dsco",
                "MAXZOOM=16",
                "-t_srs",
                "EPSG:4326",
                str(temp_pmtiles),
                str(enriched_geojsonl),
            ],
            check=True,
        )
        temp_pmtiles.replace(args.pmtiles)

    if args.manifest.exists():
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
        manifest["counts"]["buildings"] = len(features)
        manifest["counts"]["buildings_measured"] = counts.get("measured", 0)
        manifest["counts"]["buildings_floors"] = counts.get("floors", 0)
        manifest["counts"]["buildings_estimated"] = counts.get("estimated", 0)
        args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"Updated manifest counts in {args.manifest}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
