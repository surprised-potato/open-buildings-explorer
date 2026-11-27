"""Read one place's share of the downloaded OSM snapshot (data/osm/<region>/, from extract_osm_region.py).

Replaces live Overpass queries: an Overpass `(south,west,north,east)` filter is reproduced here with the
place's bbox, using the same rule Overpass applies:
  node      its coordinate is inside the box
  way       any of its points is inside the box (or, for `out center` records, its centre)
  relation  any member way point is inside the box
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from place import REPO_ROOT

REGION_DIR = REPO_ROOT / "data" / "osm" / "negros-occidental"
Bbox = tuple[float, float, float, float]  # west, south, east, north


class SnapshotMissing(RuntimeError):
    pass


@lru_cache(maxsize=None)
def _load(name: str, folder: str) -> Any:
    path = Path(folder) / name
    if not path.exists():
        raise SnapshotMissing(f"{path} is missing: run `npm run data:osm-extract` (needs the Geofabrik file in data/osm/geofabrik/)")
    return json.loads(path.read_text(encoding="utf-8"))


def load(name: str, folder: Path = REGION_DIR) -> Any:
    return _load(name, str(folder))


def meta(folder: Path = REGION_DIR) -> dict[str, Any]:
    return load("meta.json", folder)


def source_label(folder: Path = REGION_DIR) -> str:
    m = meta(folder)
    return f"OpenStreetMap snapshot {m.get('osm_timestamp', '')[:10]} ({m.get('pbf', 'Geofabrik extract')})"


def _pt_in(p: dict[str, float], bbox: Bbox) -> bool:
    w, s, e, n = bbox
    return s <= p["lat"] <= n and w <= p["lon"] <= e


def in_bbox(el: dict[str, Any], bbox: Bbox) -> bool:
    if "lat" in el and "lon" in el:
        return _pt_in(el, bbox)
    if el.get("geometry"):
        return any(_pt_in(p, bbox) for p in el["geometry"])
    if el.get("center"):
        return _pt_in(el["center"], bbox)
    for m in el.get("members") or []:
        if m.get("geometry") and any(_pt_in(p, bbox) for p in m["geometry"]):
            return True
    return False


def elements(name: str, bbox: Bbox, folder: Path = REGION_DIR) -> list[dict[str, Any]]:
    """Overpass-shaped elements from <name> (a {"elements": [...]} file) inside bbox."""
    return [el for el in load(name, folder)["elements"] if in_bbox(el, bbox)]


def transport(bbox: Bbox, folder: Path = REGION_DIR) -> dict[str, Any]:
    """The five result sets fetch_osm_transport used to query from Overpass, each as {"elements": [...]}."""
    t = load("transport.json", folder)
    out = {key: {"elements": [el for el in t[key] if in_bbox(el, bbox)]} for key in ("signals", "crossings", "stops", "routes")}
    # The road audit only needs tags (Overpass `out tags`); geometry is kept in the snapshot just to place them.
    out["roads"] = {"elements": [{k: v for k, v in el.items() if k != "geometry"} for el in t["roads"] if in_bbox(el, bbox)]}
    return out


def boundaries(folder: Path = REGION_DIR) -> list[dict[str, Any]]:
    return load("boundaries.geojson", folder)["features"]
