"""Download the province's share of an Overture Maps release once, as local GeoParquet.

After this, fetch_bacolod.py and enrich_osm_buildings.py read data/overture/<region>/*.parquet instead of
querying the S3 release for every LGU (overture_path() in fetch_bacolod.py picks the local file).

Output: data/overture/<region>/<theme>-<type>.parquet for
  buildings/building, buildings/building_part, transportation/segment, base/water, base/land_use,
  divisions/division, divisions/division_area, places/place
and meta.json (release, bbox, row counts, sizes). Rows are kept when their bbox overlaps the region bbox.
Licences: Overture themes are ODbL (buildings, transportation, base, divisions) or CDLA-Permissive (places).
Run: uv run python scripts/extract_overture_region.py [--only buildings-building,...]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, load_region  # noqa: E402

LAYERS = [
    ("divisions", "division"), ("divisions", "division_area"), ("base", "water"), ("base", "land_use"),
    ("transportation", "segment"), ("places", "place"), ("buildings", "building_part"), ("buildings", "building"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="negros-occidental")
    ap.add_argument("--only", type=lambda s: s.split(","), default=None, help="theme-type names, comma separated")
    ap.add_argument("--place", default=None, help="ignored; accepted so the pipeline can pass it")
    args = ap.parse_args()

    from fetch_bacolod import OVERTURE_RELEASE, S3_BASE, create_duckdb_connection

    reg = load_region(args.region)
    w, s, e, n = reg["bbox"]
    out_dir = REPO_ROOT / "data" / "overture" / args.region
    out_dir.mkdir(parents=True, exist_ok=True)
    meta_path = out_dir / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    if meta.get("release") != OVERTURE_RELEASE:
        meta = {"release": OVERTURE_RELEASE, "bbox": [w, s, e, n], "layers": {}}
    con = create_duckdb_connection()
    con.execute("SET threads = 8;")
    for theme, kind in LAYERS:
        name = f"{theme}-{kind}"
        if args.only and name not in args.only:
            continue
        dest = out_dir / f"{name}.parquet"
        tmp = out_dir / f"{name}.parquet.part"
        src = f"{S3_BASE}/theme={theme}/type={kind}/*.parquet"
        where = f"bbox.xmin <= {e} AND bbox.xmax >= {w} AND bbox.ymin <= {n} AND bbox.ymax >= {s}"
        if theme == "divisions":
            where += " AND country = 'PH'"
        t0 = time.time()
        print(f"{name}: downloading ...", flush=True)
        con.execute(f"COPY (SELECT * FROM read_parquet('{src}') WHERE {where}) TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        rows = con.execute(f"SELECT count(*) FROM read_parquet('{tmp}')").fetchone()[0]
        tmp.replace(dest)
        meta["layers"][name] = {"rows": int(rows), "mb": round(dest.stat().st_size / 1e6, 1), "seconds": round(time.time() - t0)}
        meta_path.write_text(json.dumps(meta, indent=2) + "\n")
        print(f"{name}: {rows:,} rows, {dest.stat().st_size / 1e6:.1f} MB in {time.time() - t0:.0f}s", flush=True)
    print(f"Overture {OVERTURE_RELEASE} for {args.region}: {sum(l['mb'] for l in meta['layers'].values()):.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
