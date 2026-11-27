# File: osm_import.py
"""Tk-free helpers: fetch OSM street data (Overpass API), convert it into the
simulator's Node/Edge objects, and small geo utilities (centroid, point-in-polygon,
nearest nodes) used for polygon zones."""
import math
from typing import Dict, List, Optional, Tuple

import networkx as nx

from data_structures import Node, Edge

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "trafficsim-desktop/0.1 (educational traffic assignment tool)"

HIGHWAY_REGEX = (
    "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|"
    "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"
)

# km/h and veh/h/lane defaults by OSM highway class
DEFAULT_SPEED = {
    "motorway": 100, "trunk": 80, "primary": 60, "secondary": 50, "tertiary": 40,
    "unclassified": 40, "residential": 30, "living_street": 15,
    "motorway_link": 60, "trunk_link": 50, "primary_link": 40,
    "secondary_link": 40, "tertiary_link": 30,
}
LANE_CAPACITY = {
    "motorway": 2000, "trunk": 1800, "primary": 1600, "secondary": 1200,
    "tertiary": 1000, "motorway_link": 1500, "trunk_link": 1400,
}
DEFAULT_LANE_CAPACITY = 800
MAX_EDGES_DEFAULT = 3000


class OSMImportError(Exception):
    """Raised for fetch failures or an area that is too large."""


# ---------------------------------------------------------------- geo utilities
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def polyline_length_km(points: List[Tuple[float, float]]) -> float:
    return sum(haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(points, points[1:]))


def point_in_polygon(lat: float, lon: float, polygon: List[Tuple[float, float]]) -> bool:
    """Ray casting; polygon is [(lat, lon), ...] (open or closed)."""
    inside = False
    n = len(polygon)
    for i in range(n):
        y1, x1 = polygon[i]
        y2, x2 = polygon[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            x_cross = (x2 - x1) * (lat - y1) / (y2 - y1) + x1
            if lon < x_cross:
                inside = not inside
    return inside


def polygon_centroid(polygon: List[Tuple[float, float]]) -> Tuple[float, float]:
    """Area centroid (shoelace). Falls back to vertex mean for degenerate polygons."""
    n = len(polygon)
    if n == 0:
        raise ValueError("Empty polygon")
    area2 = 0.0
    cy = cx = 0.0
    for i in range(n):
        y1, x1 = polygon[i]
        y2, x2 = polygon[(i + 1) % n]
        cross = x1 * y2 - x2 * y1
        area2 += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if abs(area2) < 1e-14:
        return (sum(p[0] for p in polygon) / n, sum(p[1] for p in polygon) / n)
    return (cy / (3 * area2), cx / (3 * area2))


def nearest_nodes(lat: float, lon: float, nodes: List[Node], k: int = 1,
                  inside: Optional[List[Tuple[float, float]]] = None) -> List[Node]:
    """k nearest nodes to (lat, lon). If `inside` polygon is given, nodes inside it are
    preferred; if fewer than k are inside, the rest are filled with the nearest overall."""
    if not nodes:
        return []
    import numpy as np
    la = np.radians([n.lat for n in nodes]); lo = np.radians([n.lon for n in nodes])
    p1 = math.radians(lat)
    h = np.sin((la - p1) / 2) ** 2 + math.cos(p1) * np.cos(la) * np.sin((lo - math.radians(lon)) / 2) ** 2
    ranked = [nodes[i] for i in np.argsort(h, kind="stable")]
    if inside:
        in_poly = [n for n in ranked if point_in_polygon(n.lat, n.lon, inside)]
        chosen = in_poly[:k]
        if len(chosen) < k:
            chosen += [n for n in ranked if n not in chosen][: k - len(chosen)]
        return chosen
    return ranked[:k]


# ---------------------------------------------------------------- fetching
def build_query(bbox: Optional[Tuple[float, float, float, float]] = None,
                polygon: Optional[List[Tuple[float, float]]] = None) -> str:
    """bbox = (south, west, north, east); polygon = [(lat, lon), ...]."""
    if polygon:
        area = '(poly:"' + " ".join(f"{la:.6f} {lo:.6f}" for la, lo in polygon) + '")'
    elif bbox:
        area = "({:.6f},{:.6f},{:.6f},{:.6f})".format(*bbox)
    else:
        raise ValueError("Need a bbox or polygon")
    return (
        "[out:json][timeout:60];"
        f'way["highway"~"{HIGHWAY_REGEX}"]["access"!~"^(no|private)$"]{area};'
        "out geom;"
    )


def fetch_overpass(bbox=None, polygon=None, timeout: int = 70) -> dict:
    import requests  # local import keeps the pure functions importable without it
    query = build_query(bbox, polygon)
    last_err = None
    for url in OVERPASS_URLS:
        try:
            resp = requests.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT},
                                 timeout=timeout)
            if resp.status_code == 429:
                last_err = "Overpass is rate-limiting requests (429); try again in a minute."
                continue
            resp.raise_for_status()
            return resp.json()
        except Exception as e:  # network, HTTP, JSON
            last_err = str(e)
    raise OSMImportError(f"Could not fetch OSM data: {last_err}")


# ---------------------------------------------------------------- conversion
def _parse_maxspeed(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        parts = value.strip().lower().split()
        speed = float(parts[0])
        if len(parts) > 1 and "mph" in parts[1]:
            speed *= 1.609344
        return speed if speed > 0 else None
    except ValueError:
        return None


def _oneway_direction(tags: dict) -> int:
    """1 = forward only, -1 = reverse only, 0 = both directions."""
    ow = str(tags.get("oneway", "")).lower()
    if ow in ("yes", "true", "1"):
        return 1
    if ow == "-1":
        return -1
    if ow in ("no", "false", "0"):
        return 0
    if tags.get("junction") in ("roundabout", "circular"):
        return 1
    if tags.get("highway") in ("motorway", "motorway_link"):
        return 1
    return 0


def _lanes_per_direction(tags: dict, oneway: bool) -> int:
    try:
        lanes = int(str(tags.get("lanes", "")).split(";")[0])
    except ValueError:
        return 1
    return max(1, lanes if oneway else lanes // 2)


def build_graph(data: dict, mode_id: Optional[str] = None,
                polygon: Optional[List[Tuple[float, float]]] = None,
                max_edges: Optional[int] = MAX_EDGES_DEFAULT,
                max_nodes: Optional[int] = None) -> Tuple[List[Node], List[Edge]]:
    """Convert Overpass JSON (out geom) to simplified Node/Edge lists.

    Nodes are junctions/dead ends only (id 'osm<osm_id>'); edge `geometry` keeps the road
    shape; distance is km along that geometry; free_flow_time is minutes.
    Two-way roads yield one Edge per direction. Only the largest strongly connected
    component is kept, and edges with no endpoint inside `polygon` are dropped.
    """
    ways = [w for w in data.get("elements", [])
            if w.get("type") == "way" and w.get("geometry") and w.get("nodes")
            and len(w["nodes"]) == len(w["geometry"])]

    usage: Dict[int, int] = {}
    for w in ways:
        for nid in set(w["nodes"]):
            usage[nid] = usage.get(nid, 0) + 1
        # a loop that revisits a node should split there too
        seen = set()
        for nid in w["nodes"]:
            if nid in seen:
                usage[nid] += 1
            seen.add(nid)

    coords: Dict[int, Tuple[float, float]] = {}
    raw_edges = []  # (u, v, geometry, length_km, tags)
    for w in ways:
        nids = w["nodes"]
        geom = [(g["lat"], g["lon"]) for g in w["geometry"]]
        for nid, pt in zip(nids, geom):
            coords[nid] = pt
        tags = w.get("tags", {})
        cut = [i for i, nid in enumerate(nids) if i in (0, len(nids) - 1) or usage[nid] >= 2]
        direction = _oneway_direction(tags)
        for a, b in zip(cut, cut[1:]):
            u, v = nids[a], nids[b]
            if u == v:
                continue
            seg = geom[a:b + 1]
            length = max(polyline_length_km(seg), 0.001)
            if direction >= 0:
                raw_edges.append((u, v, seg, length, tags, direction == 1))
            if direction <= 0:
                raw_edges.append((v, u, list(reversed(seg)), length, tags, direction == -1))

    if polygon:
        raw_edges = [e for e in raw_edges
                     if point_in_polygon(*coords[e[0]], polygon) or point_in_polygon(*coords[e[1]], polygon)]

    g = nx.DiGraph()
    g.add_edges_from((e[0], e[1]) for e in raw_edges)
    if g.number_of_nodes() == 0:
        return [], []
    keep = max(nx.strongly_connected_components(g), key=len)
    raw_edges = [e for e in raw_edges if e[0] in keep and e[1] in keep]

    if max_edges and len(raw_edges) > max_edges:
        raise OSMImportError(
            f"Area too large: {len(raw_edges)} road segments (limit {max_edges}). Zoom in, draw a smaller polygon, or raise the limit (Map > Set Import Limits).")
    n_nodes = len({e[0] for e in raw_edges} | {e[1] for e in raw_edges})
    if max_nodes and n_nodes > max_nodes:
        raise OSMImportError(
            f"Area too large: {n_nodes} nodes (limit {max_nodes}). Zoom in, draw a smaller polygon, or raise the limit (Map > Set Import Limits).")

    nodes: Dict[int, Node] = {}
    edges: List[Node] = []
    seen_pairs = set()
    for u, v, seg, length, tags, is_oneway in raw_edges:
        if (u, v) in seen_pairs:  # parallel ways between the same junctions: keep first
            continue
        seen_pairs.add((u, v))
        for nid in (u, v):
            if nid not in nodes:
                nodes[nid] = Node(id=f"osm{nid}", lat=coords[nid][0], lon=coords[nid][1], name=f"osm{nid}")
        hw = tags.get("highway", "residential")
        speed = _parse_maxspeed(tags.get("maxspeed")) or DEFAULT_SPEED.get(hw, 30)
        lanes = _lanes_per_direction(tags, is_oneway)
        capacity = LANE_CAPACITY.get(hw, DEFAULT_LANE_CAPACITY) * lanes
        minutes = length / speed * 60.0
        modal = {mode_id: {"cost": round(length, 4), "duration": round(minutes, 4)}} if mode_id else {}
        edges.append(Edge(start_node_id=f"osm{u}", end_node_id=f"osm{v}", distance=round(length, 4),
                          capacity=float(capacity), free_flow_time=round(minutes, 4),
                          modal_values=modal, geometry=[list(p) for p in seg]))
    return list(nodes.values()), edges
