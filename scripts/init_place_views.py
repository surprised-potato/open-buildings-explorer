"""Write a starting overrides/<place>/place.json (home view and camera presets) for configured LGUs.

The home view opens on the town proper (the OSM place=city/town node, else the Overture locality point
with the LGU's name, inside its outline) rather than an arbitrary point in the LGU. Presets: the town
centre and a whole-LGU overview. Existing files are left alone (they may hold hand-picked landmarks).
Run: uv run python -I scripts/init_place_views.py [--place talisay] [--force]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from names import lgu_key  # noqa: E402
from place import REPO_ROOT, all_places  # noqa: E402

OSM_DIR = REPO_ROOT / "data" / "osm" / "negros-occidental"
OVERTURE = REPO_ROOT / "data" / "overture" / "negros-occidental" / "divisions-division.parquet"


def overview_zoom(bbox: list[float]) -> float:
    """Zoom that fits the bbox in a ~1200 px wide view."""
    span = max(bbox[2] - bbox[0], (bbox[3] - bbox[1]) * 1.4, 1e-3)
    return round(max(9.5, min(13.5, math.log2(360 * 1200 / 256 / span) - 0.3)), 1)


def town_centre(place, outline) -> tuple[float, float] | None:
    from shapely.geometry import Point

    key = lgu_key(place.name)
    for el in json.loads((OSM_DIR / "places.json").read_text(encoding="utf-8"))["elements"]:
        t = el["tags"]
        if t.get("place") in ("city", "town") and lgu_key(t.get("name", "")) == key and outline.contains(Point(el["lon"], el["lat"])):
            return el["lon"], el["lat"]
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    for name, lon, lat in con.execute(
        f"SELECT names.primary, ST_X(geometry), ST_Y(geometry) FROM read_parquet('{OVERTURE}') "
        "WHERE subtype = 'locality' AND ST_GeometryType(geometry) = 'POINT'").fetchall():
        if name and lgu_key(name) == key and outline.contains(Point(lon, lat)):
            return lon, lat
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--place", action="append")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    from shapely.geometry import shape

    bounds = json.loads((OSM_DIR / "boundaries.geojson").read_text(encoding="utf-8"))["features"]
    for p in all_places():
        if args.place and p.slug not in args.place:
            continue
        if p.setting("boundary_mode") != "fill":
            continue
        out = p.overrides_dir() / "place.json"
        if out.exists() and not args.force:
            continue
        rel = p.setting("osm_relation")
        feat = next((f for f in bounds if f["properties"]["osm_relation"] == rel), None)
        if feat is None:
            continue
        outline = shape(feat["geometry"]).buffer(0)
        centre = town_centre(p, outline) or tuple(p.center)
        bbox = list(p.bbox)
        mid = [round((bbox[0] + bbox[2]) / 2, 5), round((bbox[1] + bbox[3]) / 2, 5)]
        c = [round(centre[0], 5), round(centre[1], 5)]
        view = {
            "homeView": {"center": c, "zoom": 15.2, "pitch": 55, "bearing": 0},
            "cameraPresets": [
                {"id": "centre", "label": f"{p.name} Town Centre", "center": c, "zoom": 15.6, "pitch": 55, "bearing": 0},
                {"id": "overview", "label": f"{p.name} Overview", "center": mid, "zoom": overview_zoom(bbox), "pitch": 40, "bearing": 0},
            ],
            "landmarks": [],
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(view, indent=2) + "\n", encoding="utf-8")
        print(f"{p.slug:<20} centre {c} ({'town point' if centre != tuple(p.center) else 'fallback'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
