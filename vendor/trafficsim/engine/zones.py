# File: engine/zones.py
"""Zone sources for city-wide models: grid cells, OSM administrative boundaries, and
connector helpers. Polygons are [(lat, lon), ...]."""
import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

import osm_import
from geometry import metres_to_deg

BBox = Tuple[float, float, float, float]
Polygon = List[Tuple[float, float]]


def grid_zones(bbox: BBox, cell_m: float = 1000.0, clip: Optional[Polygon] = None,
               max_zones: int = 400) -> List[dict]:
    """Rectangular cells covering bbox; with `clip`, keep cells whose centre is inside it.
    Raises ValueError if more than max_zones would be created."""
    s, w, n, e = bbox
    mid = (s + n) / 2
    dlat, dlon = metres_to_deg(mid, cell_m, cell_m)
    rows = max(1, math.ceil((n - s) / dlat))
    cols = max(1, math.ceil((e - w) / dlon))
    if rows * cols > max_zones * 10:
        raise ValueError(f"{rows * cols} cells; increase the cell size (limit {max_zones}).")
    out = []
    for r in range(rows):
        for c in range(cols):
            la0, lo0 = s + r * dlat, w + c * dlon
            la1, lo1 = min(la0 + dlat, n), min(lo0 + dlon, e)
            centre = ((la0 + la1) / 2, (lo0 + lo1) / 2)
            if clip and not osm_import.point_in_polygon(centre[0], centre[1], clip):
                continue
            out.append({"name": f"Z{r + 1}-{c + 1}",
                        "polygon": [(la0, lo0), (la0, lo1), (la1, lo1), (la1, lo0)]})
    if len(out) > max_zones:
        raise ValueError(f"{len(out)} zones; increase the cell size (limit {max_zones}).")
    return out


def boundary_query(bbox: BBox, admin_level: int) -> str:
    return ("[out:json][timeout:90];"
            f'relation["boundary"="administrative"]["admin_level"="{int(admin_level)}"]'
            "({:.6f},{:.6f},{:.6f},{:.6f});out geom;".format(*bbox))


GAP_M = 500.0     # largest gap between boundary fragments that is bridged with a straight line


def _dist_m(a, b) -> float:
    return math.hypot((a[0] - b[0]) * 110570.0, (a[1] - b[1]) * 111320.0 * math.cos(math.radians(a[0])))


def _stitch(segments: List[List[Tuple[float, float]]], max_gap_m: float = GAP_M, repaired: Optional[list] = None) -> List[Polygon]:
    """Join way fragments end-to-end into closed rings. Fragments whose ends are within max_gap_m
    (but do not share a node) are bridged; `repaired` (if given) gets the bridged gap lengths in metres."""
    segs = [list(s) for s in segments if len(s) >= 2]
    chains = []
    while segs:
        ring = segs.pop(0)
        grew = True
        while grew and ring[0] != ring[-1]:
            grew = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                grew = True
                break
        chains.append(ring)
    rings = [c[:-1] for c in chains if c[0] == c[-1] and len(c) >= 4]
    open_chains = [c for c in chains if c[0] != c[-1]]
    # bridge small gaps: repeatedly join the closest pair of chain ends
    while open_chains:
        best = None
        for i, c in enumerate(open_chains):
            for j in range(i, len(open_chains)):
                d = open_chains[j]
                if i == j:
                    cand = [(_dist_m(c[-1], c[0]), "close")]
                else:
                    cand = [(_dist_m(c[-1], d[0]), "cd"), (_dist_m(c[-1], d[-1]), "cD"), (_dist_m(c[0], d[0]), "Cd"), (_dist_m(c[0], d[-1]), "CD")]
                for dist, how in cand:
                    if dist <= max_gap_m and (best is None or dist < best[0]):
                        best = (dist, i, j, how)
        if best is None:
            break
        dist, i, j, how = best
        if repaired is not None:
            repaired.append(round(dist))
        c = open_chains[i]
        if how == "close":
            rings.append(c[:] if len(c) >= 3 else c)
            open_chains.pop(i)
            continue
        d = open_chains[j]
        merged = {"cd": c + d, "cD": c + d[::-1], "Cd": c[::-1] + d, "CD": d + c}[how]
        open_chains = [x for k, x in enumerate(open_chains) if k not in (i, j)] + [merged]
    return [r for r in rings if len(r) >= 3]


def _ring_from_geometry(geom) -> Optional[List[Tuple[float, float]]]:
    pts = [(g["lat"], g["lon"]) for g in geom]
    return pts[:-1] if len(pts) >= 4 and pts[0] == pts[-1] else None


def parse_boundaries(data: dict, min_vertices: int = 3) -> List[dict]:
    """Overpass JSON (out geom) -> [{name, polygon, osm_type, osm_id, repaired_gaps_m}].
    Relations use their largest outer ring (small gaps are bridged); closed ways tagged as boundaries are
    accepted too (OSM allows simple boundaries as a single closed way). Relations win over ways of the same name."""
    zones = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name") or f"{el.get('type')}{el.get('id')}"
        if el.get("type") == "relation":
            outer = [[(g["lat"], g["lon"]) for g in m["geometry"]]
                     for m in el.get("members", [])
                     if m.get("type") == "way" and m.get("role") == "outer" and m.get("geometry")]
            gaps: list = []
            rings = _stitch(outer, repaired=gaps)
            ring = max(rings, key=len) if rings else None
        elif el.get("type") == "way" and el.get("geometry"):
            ring, gaps = _ring_from_geometry(el["geometry"]), []
        else:
            continue
        if ring and len(ring) >= min_vertices:
            zones.append({"name": name, "polygon": ring, "osm_type": el["type"], "osm_id": el.get("id"), "repaired_gaps_m": gaps})
    seen, out = {}, []
    for z in sorted(zones, key=lambda z: z["osm_type"] != "relation"):
        if z["name"] not in seen:
            seen[z["name"]] = z
            out.append(z)
    return out


def fetch_boundaries(bbox: BBox, admin_level: int) -> List[dict]:
    import requests
    q = boundary_query(bbox, admin_level)
    last = None
    for url in osm_import.OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": q}, headers={"User-Agent": osm_import.USER_AGENT}, timeout=100)
            r.raise_for_status()
            return parse_boundaries(r.json())
        except Exception as ex:
            last = ex
    raise osm_import.OSMImportError(f"Could not fetch boundaries: {last}")


def connector_targets(net, centroid: Tuple[float, float], polygon: Optional[Polygon], k: int = 2) -> List[int]:
    """k road-node indices for a zone centroid (FastNetwork + cKDTree), preferring nodes
    inside the polygon; fills with the nearest overall."""
    pool = net.nearest_nodes(centroid[0], centroid[1], k=min(max(k * 15, 30), int((~net.is_zone).sum())))
    if polygon:
        inside = [int(i) for i in pool if osm_import.point_in_polygon(net.lat[i], net.lon[i], polygon)]
        chosen = inside[:k]
        chosen += [int(i) for i in pool if int(i) not in chosen][: k - len(chosen)]
        return chosen
    return [int(i) for i in pool[:k]]


def node_speeds(net) -> "np.ndarray":
    """Highest free-flow speed (km/h) of any real road touching each node (connectors ignored)."""
    spd = net.length / np.maximum(net.t0_ref, 1e-6) * 60.0
    real = ~(net.is_zone[net.src] | net.is_zone[net.dst])
    out = np.zeros(net.n_nodes)
    np.maximum.at(out, net.src[real], spd[real])
    np.maximum.at(out, net.dst[real], spd[real])
    return out


def junction_weights(net) -> "np.ndarray":
    """Importance of every road node as a place to enter/leave the zone: the sum of its branches' importance, where a
    branch is a distinct neighbouring junction (a two-way road counts once) weighted by sqrt(capacity/1000 x speed/40).
    Dead ends score 0, a bend (2 branches) is discounted, a 3-way junction counts fully and a 4+-way junction gets a bonus,
    so major multi-branch junctions on big roads rank first."""
    real = ~(net.is_zone[net.src] | net.is_zone[net.dst])
    a, b = net.src[real], net.dst[real]
    spd = (net.length / np.maximum(net.t0_ref, 1e-6) * 60.0)[real]
    imp = np.sqrt(np.maximum(net.capacity[real], 1.0) / 1000.0 * np.maximum(spd, 5.0) / 40.0)
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    keep = lo != hi
    key = lo[keep].astype(np.int64) * net.n_nodes + hi[keep]
    uk, inv = np.unique(key, return_inverse=True)
    best = np.zeros(len(uk))
    np.maximum.at(best, inv, imp[keep])                               # strongest direction of each branch
    u, v = uk // net.n_nodes, uk % net.n_nodes
    w = np.zeros(net.n_nodes); deg = np.zeros(net.n_nodes)
    for end in (u, v):
        np.add.at(w, end, best)
        np.add.at(deg, end, 1.0)
    factor = np.select([deg <= 1, deg == 2, deg == 3], [0.0, 0.35, 1.0], 1.15)
    return w * factor


def hierarchy_weights(net, nodes, decay: float = 1.0):
    """Hierarchical junction score within one zone. Roads are levelled by speed (2: >=55 km/h, 1: 35-55, 0: slower) and a
    node's level is its best road. Starting from the lowest level, every node hands its accumulated mass (half the length
    of its roads, plus what its own children gave it) to its parent: the nearest node of a higher level along roads of
    its own level or lower. So a junction on a major road ends up holding the road length of the whole branch tree
    (children, grandchildren, ...) that hangs off it. Score = mass x branch factor (dead end 0, bend .35, 3-way 1, 4+ 1.15).
    Returns (score, level) arrays over all network nodes (level -1 / score 0 outside `nodes`)."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    n = net.n_nodes
    score = np.zeros(n); level = np.full(n, -1, dtype=int)
    nodes = np.asarray(nodes, dtype=int)
    if len(nodes) == 0:
        return score, level
    inz = np.zeros(n, dtype=bool); inz[nodes] = True
    real = ~(net.is_zone[net.src] | net.is_zone[net.dst]) & inz[net.src] & inz[net.dst] & (net.src != net.dst)
    a, b = net.src[real], net.dst[real]
    if len(a) == 0:
        return score, level
    spd = (net.length / np.maximum(net.t0_ref, 1e-6) * 60.0)[real]
    ln = net.length[real]
    el = np.where(spd >= 55.0, 2, np.where(spd >= 35.0, 1, 0))
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    key = lo.astype(np.int64) * n + hi
    uk, first, inv = np.unique(key, return_index=True, return_inverse=True)       # undirected roads (a two-way pair = one)
    u, v = uk // n, uk % n
    rl = np.zeros(len(uk)); np.maximum.at(rl, inv, ln)
    rlev = np.zeros(len(uk), dtype=int); np.maximum.at(rlev, inv, el)
    mass = np.zeros(n); deg = np.zeros(n)
    for end in (u, v):
        np.add.at(mass, end, rl / 2.0)
        np.add.at(deg, end, 1.0)
        np.maximum.at(level, end, rlev)
    mid = np.unique(np.concatenate([u, v]))
    m = len(mid)                                                        # compact local indices keep the graphs small
    lu, lv = np.searchsorted(mid, u), np.searchsorted(mid, v)
    llev = level[mid]; lmass = mass[mid].copy()
    for l in range(int(llev.min()), int(llev.max())):
        keep = rlev <= l
        src = np.flatnonzero(llev > l)
        if not keep.any() or len(src) == 0:
            continue
        g = csr_matrix((rl[keep] + 1e-9, (lu[keep], lv[keep])), shape=(m, m))
        dist, _, srcs = dijkstra(g, directed=False, indices=src, min_only=True, return_predecessors=True)
        kids = np.flatnonzero((llev == l) & np.isfinite(dist) & (srcs >= 0))
        np.add.at(lmass, srcs[kids], decay * lmass[kids])
    mass[mid] = lmass
    factor = np.select([deg <= 1, deg == 2, deg == 3], [0.0, 0.35, 1.0], 1.15)
    score[mid] = mass[mid] * factor[mid]
    level[~np.isin(np.arange(n), mid)] = -1
    return score, level


def weighted_targets(net, cand, weights, k: int, polygon=None) -> List[int]:
    """Top-k candidates by junction weight with a minimum spacing, so the entry points are the best junctions but still
    cover the zone instead of sitting on one intersection cluster. The spacing starts at half the typical cell size
    (polygon area / k) and is relaxed until k nodes are found."""
    cand = np.asarray(cand, dtype=int)
    kx = math.cos(math.radians(float(net.lat[cand].mean())))
    xy = np.column_stack([net.lat[cand] * 110540.0, net.lon[cand] * 111320.0 * kx])
    if polygon and len(polygon) >= 3:
        px = np.array([[p[0] * 110540.0, p[1] * 111320.0 * kx] for p in polygon])
        area = abs(float(np.dot(px[:, 0], np.roll(px[:, 1], -1)) - np.dot(px[:, 1], np.roll(px[:, 0], -1)))) / 2.0
    else:
        area = float(np.ptp(xy[:, 0]) * np.ptp(xy[:, 1]))
    r = 0.5 * math.sqrt(max(area, 1.0) / max(k, 1))
    order = cand[np.argsort(-weights[cand], kind="stable")]
    pos = {int(n): i for i, n in enumerate(cand)}
    k = min(k, len(cand))
    while True:
        chosen: List[int] = []
        for n in order:
            p = xy[pos[int(n)]]
            if all(((xy[pos[c]] - p) ** 2).sum() >= r * r for c in chosen):
                chosen.append(int(n))
                if len(chosen) == k:
                    return chosen
        if r < 25.0:
            rest = [int(n) for n in order if int(n) not in chosen]
            return (chosen + rest)[:k]
        r *= 0.6


def spread_targets(net, centroid: Tuple[float, float], polygon: Optional[Polygon], k: int = 2,
                   speeds=None, min_speed: float = 35.0, weights=None, hierarchical: bool = False) -> List[int]:
    """k road nodes for a zone's entry points, spread over the polygon instead of clustered at the centroid.
    Candidates are the road nodes inside the polygon (nearest ones if there are too few); nodes on collector-or-faster
    roads (>= min_speed km/h) are preferred so zone traffic enters the network on real roads rather than one
    residential street. The first entry point is the candidate nearest the centroid, the rest are chosen by
    farthest-point sampling."""
    k = max(1, int(k))
    road = np.flatnonzero(~net.is_zone)
    if len(road) == 0:
        return []
    kx = math.cos(math.radians(centroid[0]))
    if polygon:
        la = [p[0] for p in polygon]; lo = [p[1] for p in polygon]
        box = road[(net.lat[road] >= min(la)) & (net.lat[road] <= max(la)) & (net.lon[road] >= min(lo)) & (net.lon[road] <= max(lo))]
        cand = np.array([i for i in box if osm_import.point_in_polygon(net.lat[i], net.lon[i], polygon)], dtype=int)
    else:
        cand = np.zeros(0, dtype=int)
    if len(cand) < max(k, 3):                       # tiny polygon / no polygon: fall back to the nearest nodes
        near = net.nearest_nodes(centroid[0], centroid[1], k=min(max(k * 15, 30), len(road)))
        cand = np.unique(np.concatenate([cand, near]))
    if hierarchical:
        score, lev = hierarchy_weights(net, cand)
        pool = np.zeros(0, dtype=int)
        for l in sorted(set(lev[cand].tolist()), reverse=True):             # top level first; add lower levels until the pool is >= 4k so a short fast stub cannot take every entry point
            if l < 0:
                continue
            pool = np.concatenate([pool, cand[(lev[cand] == l) & (score[cand] > 0)]])
            if len(pool) >= max(4 * k, 12):                              # enough junctions to spread over the whole zone
                break
        if len(pool) >= 1:
            return weighted_targets(net, pool, score, k, polygon)
    if weights is not None:
        return weighted_targets(net, cand, weights, k, polygon)
    if speeds is not None:
        fast = cand[speeds[cand] >= min_speed]
        if len(fast) >= k:
            cand = fast
    xy = np.column_stack([net.lat[cand], net.lon[cand] * kx])
    c0 = np.array([centroid[0], centroid[1] * kx])
    first = int(np.argmin(((xy - c0) ** 2).sum(axis=1)))
    chosen = [first]
    mind = ((xy - xy[first]) ** 2).sum(axis=1)
    while len(chosen) < min(k, len(cand)):
        nxt = int(np.argmax(mind))
        if mind[nxt] <= 0:
            break
        chosen.append(nxt)
        mind = np.minimum(mind, ((xy - xy[nxt]) ** 2).sum(axis=1))
    return [int(cand[i]) for i in chosen]
