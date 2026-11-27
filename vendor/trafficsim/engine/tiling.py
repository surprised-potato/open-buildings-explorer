# File: engine/tiling.py
"""City-sized OSM import: split the area into tiles, fetch each with an on-disk cache and
back-off, merge ways by OSM id, then build one graph (single SCC filter)."""
import hashlib
import json
import math
import os
import time
from typing import Callable, Dict, List, Optional, Tuple

import osm_import
from osm_import import OSMImportError

BBox = Tuple[float, float, float, float]  # south, west, north, east
DEFAULT_CACHE = os.path.join(os.path.expanduser("~"), ".cache", "trafficsim", "overpass")
USE_DEFAULT = "default"   # sentinel: TRAFFICSIM_CACHE env var, else DEFAULT_CACHE


def resolve_cache(cache_dir):
    return os.environ.get("TRAFFICSIM_CACHE", DEFAULT_CACHE) if cache_dir == USE_DEFAULT else cache_dir


def tile_bboxes(bbox: BBox, tile_km: float = 1.5) -> List[BBox]:
    s, w, n, e = bbox
    dlat = tile_km / 111.32
    mid = math.radians((s + n) / 2)
    dlon = tile_km / (111.32 * max(math.cos(mid), 1e-6))
    rows = max(1, math.ceil((n - s) / dlat))
    cols = max(1, math.ceil((e - w) / dlon))
    tiles = []
    for r in range(rows):
        for c in range(cols):
            tiles.append((s + r * (n - s) / rows, w + c * (e - w) / cols,
                          s + (r + 1) * (n - s) / rows, w + (c + 1) * (e - w) / cols))
    return tiles


def _cache_path(cache_dir: str, query: str) -> str:
    return os.path.join(cache_dir, hashlib.sha1(query.encode()).hexdigest() + ".json")


def fetch_tile(bbox: BBox, cache_dir: Optional[str] = USE_DEFAULT, retries: int = 3,
               fetch: Callable = None, sleep: Callable[[float], None] = time.sleep) -> Tuple[dict, bool]:
    """Returns (overpass_json, from_cache). Retries with growing back-off on failure."""
    cache_dir = resolve_cache(cache_dir)
    fetch = fetch or osm_import.fetch_overpass
    query = osm_import.build_query(bbox=bbox)
    path = _cache_path(cache_dir, query) if cache_dir else None
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f), True
        except (OSError, ValueError):
            pass  # corrupt cache entry: refetch
    err = None
    for attempt in range(retries):
        try:
            data = fetch(bbox=bbox)
            break
        except OSMImportError as e:
            err = e
            if attempt < retries - 1:
                sleep(2.0 * (attempt + 1) ** 2)
    else:
        raise OSMImportError(f"Tile {bbox} failed after {retries} tries: {err}")
    if path:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    return data, False


def merge_overpass(parts: List[dict]) -> dict:
    """Union of elements by (type, id); ways cut by tile borders appear once."""
    seen, elements = set(), []
    for part in parts:
        for el in part.get("elements", []):
            key = (el.get("type"), el.get("id"))
            if key in seen:
                continue
            seen.add(key)
            elements.append(el)
    return {"elements": elements}


def import_city(bbox: BBox, mode_id: Optional[str] = None, polygon=None, tile_km: float = 1.5,
                max_edges: Optional[int] = None, max_nodes: Optional[int] = None,
                cache_dir: Optional[str] = USE_DEFAULT,
                progress: Optional[Callable[[str, int, int], None]] = None,
                cancel: Optional[Callable[[], bool]] = None, fetch: Callable = None,
                sleep: Callable[[float], None] = time.sleep):
    """Fetch (tiled, cached) + build the graph. Returns (nodes, edges, stats).

    `progress(stage, done, total)` with stage in {"tiles", "build"}."""
    tiles = tile_bboxes(bbox, tile_km)
    parts, cached = [], 0
    for i, tb in enumerate(tiles):
        if cancel and cancel():
            raise OSMImportError("Cancelled")
        data, hit = fetch_tile(tb, cache_dir, fetch=fetch, sleep=sleep)
        cached += hit
        parts.append(data)
        if progress:
            progress("tiles", i + 1, len(tiles))
    if progress:
        progress("build", 0, 1)
    merged = merge_overpass(parts)
    nodes, edges = osm_import.build_graph(merged, mode_id=mode_id, polygon=polygon,
                                          max_edges=max_edges, max_nodes=max_nodes)
    if progress:
        progress("build", 1, 1)
    return nodes, edges, {"tiles": len(tiles), "cached": cached, "ways": len(merged["elements"])}


def query_cached(query: str, cache_dir: Optional[str] = USE_DEFAULT, retries: int = 3, timeout: int = 100,
                 sleep: Callable[[float], None] = time.sleep, post: Callable = None) -> dict:
    """Run an arbitrary Overpass query with mirror fallback, back-off and an on-disk cache."""
    cache_dir = resolve_cache(cache_dir)
    path = _cache_path(cache_dir, query) if cache_dir else None
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    if post is None:
        import requests
        post = lambda url, q: requests.post(url, data={"data": q}, headers={"User-Agent": osm_import.USER_AGENT}, timeout=timeout)
    err = None
    for attempt in range(retries):
        for url in osm_import.OVERPASS_URLS:
            try:
                r = post(url, query)
                if r.status_code == 200:
                    data = r.json()
                    if path:
                        os.makedirs(cache_dir, exist_ok=True)
                        with open(path + ".tmp", "w", encoding="utf-8") as f:
                            json.dump(data, f)
                        os.replace(path + ".tmp", path)
                    return data
                err = f"HTTP {r.status_code} from {url}"
            except Exception as e:
                err = f"{url}: {e}"
        if attempt < retries - 1:
            sleep(3.0 * (attempt + 1))
    raise OSMImportError(f"Overpass query failed: {err}")


def tile_touches_polygon(tile: BBox, polygon) -> bool:
    """True if the tile and polygon overlap (corner/centre inside, polygon vertex inside, or edge crossing by bbox test)."""
    s, w, n, e = tile
    pts = [(s, w), (s, e), (n, w), (n, e), ((s + n) / 2, (w + e) / 2)]
    if any(osm_import.point_in_polygon(a, b, polygon) for a, b in pts):
        return True
    if any(s <= la <= n and w <= lo <= e for la, lo in polygon):
        return True
    # polygon edges crossing a tile that has no vertex/corner inside: sample edge midpoints
    for (a1, b1), (a2, b2) in zip(polygon, polygon[1:] + polygon[:1]):
        for t in (0.25, 0.5, 0.75):
            la, lo = a1 + (a2 - a1) * t, b1 + (b2 - b1) * t
            if s <= la <= n and w <= lo <= e:
                return True
    return False


def fetch_tile_adaptive(bbox: BBox, depth: int = 2, **kw) -> dict:
    """fetch_tile, but a tile that keeps failing (dense areas time out) is split into 4 and retried."""
    try:
        return fetch_tile(bbox, **kw)[0]
    except OSMImportError:
        if depth <= 0:
            raise
        s, w, n, e = bbox
        ms, mw = (s + n) / 2, (w + e) / 2
        quads = [(s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)]
        merged = merge_overpass([fetch_tile_adaptive(q, depth - 1, **kw) for q in quads])
        cache_dir = resolve_cache(kw.get("cache_dir", USE_DEFAULT))
        if cache_dir:                       # remember the combined result so the failing parent isn't retried next time
            path = _cache_path(cache_dir, osm_import.build_query(bbox=bbox))
            os.makedirs(cache_dir, exist_ok=True)
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(merged, f)
            os.replace(path + ".tmp", path)
        return merged
