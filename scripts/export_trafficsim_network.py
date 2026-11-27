#!/usr/bin/env python3
"""Export Bacolod's calibrated trafficsim road graph, DEM elevations, and building-weighted
zone access nodes into browser-ready static assets:
  - public/data/bacolod/mobility_network.bin
  - public/data/bacolod/mobility_zones.json
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import struct
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
from shapely import make_valid
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

try:
    from scripts.compute_barangay_analytics import (
        CIVIC_EDU_HEALTH_CLASSES,
        INDUSTRIAL_ANALYTICS_CLASSES,
        RESIDENTIAL_ANALYTICS_CLASSES,
        estimate_floors_from_height,
        load_dem_sampler,
    )
    from scripts.enrich_osm_buildings import (
        COMMERCIAL_CLASSES,
        M_PER_DEG_LAT,
        M_PER_DEG_LON,
        load_stitched_buildings,
    )
except ImportError:
    from compute_barangay_analytics import (  # type: ignore[no-redef]
        CIVIC_EDU_HEALTH_CLASSES,
        INDUSTRIAL_ANALYTICS_CLASSES,
        RESIDENTIAL_ANALYTICS_CLASSES,
        estimate_floors_from_height,
        load_dem_sampler,
    )
    from enrich_osm_buildings import (  # type: ignore[no-redef]
        COMMERCIAL_CLASSES,
        M_PER_DEG_LAT,
        M_PER_DEG_LON,
        load_stitched_buildings,
    )

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parent.parent
# Calibrated road graph from the separate trafficsim project (Bacolod only so far). Places without
# one need a network built from OSM/Overture roads first (pipeline phase 2).
DEFAULT_STATE_DIR = PLACE.trafficsim_state or REPO_ROOT / "build" / PLACE.slug / "trafficsim_state"
DEFAULT_BUILDINGS_PMTILES = PLACE.pmtiles("buildings")
DEFAULT_BUILDING_POIS = PLACE.out_dir / "building_pois.json"
DEFAULT_DEM_MANIFEST = PLACE.out_dir / "dem" / "dem_manifest.json"
DEFAULT_OUT_DIR = PLACE.out_dir

MAGIC_BMOB = 0x424D4F42
BINARY_VERSION = 2
SENTINEL_U16 = 0xFFFF
MAGIC_BBLD = 0x444C4242
BUILDINGS_VERSION = 1
WEIGHT_SCALE = 64.0
MAX_U16_COUNT = 65535
BANNED_T0_MIN = 1e5
MAX_ACCESS_NODES_PER_ROLE = 32

MODE_ORDER: tuple[str, ...] = ("walk", "motorcycle", "tricycle", "car", "puv")
MODE_COLORS: dict[str, list[int]] = {
    "walk": [248, 250, 252],
    "motorcycle": [236, 72, 153],
    "tricycle": [16, 185, 129],
    "car": [56, 189, 248],
    "puv": [245, 158, 11],
}
MODE_PHYSICS: dict[str, dict[str, Any]] = {
    "walk": {"occupancy_min": 1, "occupancy_max": 1, "pcu": 0.0, "congests": False, "lane_filter": 0.0},
    "motorcycle": {"occupancy_min": 1, "occupancy_max": 2, "pcu": 0.4, "congests": True, "lane_filter": 0.65},
    "tricycle": {"occupancy_min": 1, "occupancy_max": 4, "pcu": 0.6, "congests": True, "lane_filter": 1.0},
    "car": {"occupancy_min": 1, "occupancy_max": 3, "pcu": 1.0, "congests": True, "lane_filter": 1.0},
    "puv": {"occupancy_min": 15, "occupancy_max": 20, "pcu": 2.0, "congests": True, "lane_filter": 1.0},
}
ROUTING_PROFILES: list[str] = ["motorized", "tricycle", "walk"]
MODE_PROFILE_MAP: dict[str, int] = {
    "walk": 2,
    "motorcycle": 0,
    "tricycle": 1,
    "car": 0,
    "puv": 0,
}

SCHOOL_CLASSES = {"school", "college", "university", "education", "library"}
OTHER_CLASSES = {
    "retail",
    "commercial",
    "mixed_use",
    "religious",
    "church",
    "cathedral",
    "chapel",
    "mosque",
    "temple",
    "hospital",
    "healthcare",
    "clinic",
    "civic",
    "public",
    "government",
    "hotel",
    "resort",
    "leisure",
}
POI_WORK_CATS = {"commercial", "retail", "office", "industrial", "hotel", "civic", "healthcare"}
POI_SCHOOL_CATS = {"education"}
POI_OTHER_CATS = {"food", "retail", "commercial", "religious", "healthcare", "civic", "hotel", "leisure"}


def compute_largest_scc(n_nodes: int, edge_src: np.ndarray, edge_dst: np.ndarray) -> list[int]:
    """Compute the largest strongly connected component via iterative Tarjan's algorithm."""
    adj: list[list[int]] = [[] for _ in range(n_nodes)]
    for s, d in zip(edge_src.tolist(), edge_dst.tolist()):
        adj[s].append(d)

    index_counter = 0
    indices = [-1] * n_nodes
    lowlink = [0] * n_nodes
    on_stack = [False] * n_nodes
    stack: list[int] = []
    best_comp: list[int] = []

    for start in range(n_nodes):
        if indices[start] != -1:
            continue
        call_stack: list[tuple[int, int]] = [(start, 0)]
        indices[start] = lowlink[start] = index_counter
        index_counter += 1
        stack.append(start)
        on_stack[start] = True

        while call_stack:
            u, it = call_stack[-1]
            neighbors = adj[u]
            if it < len(neighbors):
                call_stack[-1] = (u, it + 1)
                v = neighbors[it]
                if indices[v] == -1:
                    indices[v] = lowlink[v] = index_counter
                    index_counter += 1
                    stack.append(v)
                    on_stack[v] = True
                    call_stack.append((v, 0))
                elif on_stack[v] and indices[v] < lowlink[u]:
                    lowlink[u] = indices[v]
            else:
                call_stack.pop()
                if call_stack:
                    parent = call_stack[-1][0]
                    if lowlink[u] < lowlink[parent]:
                        lowlink[parent] = lowlink[u]
                if lowlink[u] == indices[u]:
                    comp: list[int] = []
                    while True:
                        w = stack.pop()
                        on_stack[w] = False
                        comp.append(w)
                        if w == u:
                            break
                    if len(comp) > len(best_comp):
                        best_comp = comp

    best_comp.sort()
    return best_comp


def ensure_lon_lat_coords(coords: np.ndarray) -> np.ndarray:
    """Verify coordinate column order and return float32 array in [lon, lat] order."""
    if len(coords) == 0:
        return np.zeros((0, 2), dtype=np.float32)
    c0_mean = float(np.mean(coords[:, 0]))
    c1_mean = float(np.mean(coords[:, 1]))
    # Bacolod is ~122.95 E (lon), ~10.67 N (lat). Swap if stored as (lat, lon).
    if abs(c0_mean) < 60.0 and abs(c1_mean) > 60.0:
        return np.column_stack((coords[:, 1], coords[:, 0])).astype(np.float32)
    return coords.astype(np.float32)


def dijkstra_tree(
    n_nodes: int,
    adj: list[list[tuple[int, int, float]]],
    root: int,
) -> np.ndarray:
    """Run Dijkstra from root and return prev_edge[node] (0xFFFF for root/unreachable)."""
    dist = [math.inf] * n_nodes
    prev_edge = np.full(n_nodes, SENTINEL_U16, dtype=np.uint16)
    dist[root] = 0.0
    heap: list[tuple[float, int]] = [(0.0, root)]

    while heap:
        d_u, u = heapq.heappop(heap)
        if d_u > dist[u]:
            continue
        for v, edge_idx, weight in adj[u]:
            nd = d_u + weight
            if nd < dist[v]:
                dist[v] = nd
                prev_edge[v] = edge_idx
                heapq.heappush(heap, (nd, v))

    return prev_edge


def extract_building_points(
    buildings_pmtiles: Path,
    building_pois_path: Path,
) -> list[dict[str, Any]]:
    """Load building centroids, classes, and floor-area proxies from PMTiles + POIs JSON."""
    poi_by_id: dict[str, dict[str, Any]] = {}
    if building_pois_path.exists():
        poi_by_id = json.loads(building_pois_path.read_text(encoding="utf-8"))

    records: list[dict[str, Any]] = []
    if buildings_pmtiles.exists():
        with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_mob_bldgs_") as tmp:
            ids, geoms_deg, _, props_by_id = load_stitched_buildings(
                buildings_pmtiles, Path(tmp)
            )
            for bid, geom_deg in zip(ids, geoms_deg):
                props = props_by_id.get(bid, {})
                pt = geom_deg.representative_point()
                area_m2 = float(props.get("area_m2") or 40.0)
                floors = estimate_floors_from_height(
                    props.get("effective_height"), props.get("num_floors")
                )
                est_gfa = max(10.0, area_m2 * floors)
                poi_rec = poi_by_id.get(bid)
                poi_cats = (
                    {str(p.get("category") or "").lower() for p in poi_rec.get("pois", [])}
                    if poi_rec
                    else set()
                )
                poi_name = ""
                if poi_rec:
                    poi_name = str(
                        poi_rec.get("name")
                        or poi_rec.get("label")
                        or next((p.get("name") for p in poi_rec.get("pois", []) if p.get("name")), "")
                        or ""
                    )
                records.append(
                    {
                        "id": str(bid),
                        "lon": float(pt.x),
                        "lat": float(pt.y),
                        "bclass": str(props.get("bclass") or "unknown").lower().strip(),
                        "weight": math.sqrt(est_gfa),
                        "area_m2": area_m2,
                        "name": poi_name,
                        "poi_cats": poi_cats,
                    }
                )
        return records

    # Fallback when PMTiles is absent (e.g. lightweight tests)
    for rec in poi_by_id.values():
        center = rec.get("center")
        if not center or len(center) < 2:
            continue
        poi_cats = {str(p.get("category") or "").lower() for p in rec.get("pois", [])}
        records.append(
            {
                "id": str(rec.get("id") or ""),
                "lon": float(center[0]),
                "lat": float(center[1]),
                "bclass": str(rec.get("bclass") or "unknown").lower().strip(),
                "weight": 10.0 + 5.0 * len(poi_cats),
                "area_m2": float(rec.get("area_m2") or 40.0),
                "name": str(rec.get("name") or rec.get("label") or ""),
                "poi_cats": poi_cats,
            }
        )
    return records


def building_role_weights(rec: dict[str, Any]) -> tuple[float, float, float, float]:
    """Return (home, work, school, other) activity weights for a building record."""
    bclass = rec["bclass"]
    w = float(rec["weight"])
    cats: set[str] = rec["poi_cats"]

    home = 0.0
    work = 0.0
    school = 0.0
    other = 0.0

    if bclass in RESIDENTIAL_ANALYTICS_CLASSES:
        home += w
    elif bclass == "mixed_use":
        home += 0.45 * w
        work += 0.75 * w
        other += 0.85 * w
    elif bclass == "unknown":
        # Most unclassified footprints in Bacolod residential barangays are dwellings,
        # unless they carry a named business/amenity POI.
        home += (0.02 if cats else 0.15) * w
        other += 0.02 * w

    if bclass in COMMERCIAL_CLASSES or bclass in INDUSTRIAL_ANALYTICS_CLASSES:
        work += w
    elif bclass in CIVIC_EDU_HEALTH_CLASSES:
        work += 0.5 * w

    if bclass in SCHOOL_CLASSES or bool(cats & POI_SCHOOL_CATS):
        school += w * (1.5 if cats & POI_SCHOOL_CATS else 1.0)
        work += 0.35 * w

    if bclass in OTHER_CLASSES or bool(cats & POI_OTHER_CATS):
        other += w * (1.4 if cats & POI_OTHER_CATS else 1.0)

    if cats & POI_WORK_CATS:
        work += 0.8 * w

    # Population-grid adjustment (apply_population_grid): where WorldPop puts more residents per unit of
    # building weight than the barangay average, homes there attract more trips. 1.0 when unset.
    home *= float(rec.get("home_factor", 1.0))
    return home, work, school, other


def normalize_access_list(
    scores: dict[int, float],
    fallback_nodes: list[int],
    limit: int = MAX_ACCESS_NODES_PER_ROLE,
) -> list[list[Any]]:
    """Select up to `limit` positive [nodeIdx, normalizedWeight] entries."""
    items = [(n, float(w)) for n, w in scores.items() if w > 0.0]
    if not items:
        chosen = fallback_nodes[:limit]
        if not chosen:
            return []
        u_w = round(1.0 / len(chosen), 6)
        return [[int(n), u_w] for n in chosen]

    items.sort(key=lambda kv: (-kv[1], kv[0]))
    top = items[:limit]
    total = sum(w for _, w in top)
    if total <= 0.0:
        u_w = round(1.0 / len(top), 6)
        return [[int(n), u_w] for n, _ in top]
    return [[int(n), round(w / total, 6)] for n, w in top]


def trace_spur_edges(
    start_node: int,
    hub_node: int,
    next_edge_to_hub: np.ndarray,
    edge_dst: np.ndarray,
) -> list[int]:
    """Trace outgoing edges from start_node to hub_node along reverse-Dijkstra tree."""
    edges: list[int] = []
    cur = start_node
    visited = {cur}
    while cur != hub_node:
        e = int(next_edge_to_hub[cur])
        if e == SENTINEL_U16:
            break
        edges.append(e)
        nxt = int(edge_dst[e])
        if nxt in visited:
            break
        visited.add(nxt)
        cur = nxt
    return edges


def build_zones_and_trees(
    zones_raw: list[dict[str, Any]],
    node_lon: np.ndarray,
    node_lat: np.ndarray,
    edge_src: np.ndarray,
    edge_dst: np.ndarray,
    edge_len_km: np.ndarray,
    edge_t0_sec: np.ndarray,
    edge_usable_mask: np.ndarray,
    buildings: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], np.ndarray, list[tuple[int, int, int]], np.ndarray]:
    """Select zone hubs, access nodes/spurs, fromHubPrevEdge, per-building node assignments,
    and toHubNextEdge (next edge toward each zone hub, per profile)."""
    n_nodes = len(node_lon)
    n_edges = len(edge_src)
    n_zones = len(zones_raw)

    # Precompute node road-centrality proxy (max car km/h + degree * 4)
    node_degree = np.zeros(n_nodes, dtype=np.int32)
    node_max_kmh = np.zeros(n_nodes, dtype=np.float64)
    car_t0_sec = edge_t0_sec[3 * n_edges : 4 * n_edges]
    tri_usable_incident = np.zeros(n_nodes, dtype=bool)
    for e in range(n_edges):
        s = int(edge_src[e])
        d = int(edge_dst[e])
        node_degree[s] += 1
        node_degree[d] += 1
        if edge_usable_mask[0, e] and car_t0_sec[e] > 0:
            kmh = float(edge_len_km[e]) / (float(car_t0_sec[e]) / 3600.0)
            if kmh > node_max_kmh[s]:
                node_max_kmh[s] = kmh
            if kmh > node_max_kmh[d]:
                node_max_kmh[d] = kmh
        if edge_usable_mask[1, e]:
            tri_usable_incident[s] = True
            tri_usable_incident[d] = True

    # Build adjacency lists per profile: 0=motorized (car), 1=tricycle, 2=walk
    profile_block = (3, 2, 0)
    out_adj: list[list[list[tuple[int, int, float]]]] = [
        [[] for _ in range(n_nodes)] for _ in range(3)
    ]
    in_adj: list[list[list[tuple[int, int, float]]]] = [
        [[] for _ in range(n_nodes)] for _ in range(3)
    ]
    for p_idx, mode_block in enumerate(profile_block):
        t0_block = edge_t0_sec[mode_block * n_edges : (mode_block + 1) * n_edges]
        for e in range(n_edges):
            if not edge_usable_mask[p_idx, e]:
                continue
            s = int(edge_src[e])
            d = int(edge_dst[e])
            w = float(t0_block[e])
            out_adj[p_idx][s].append((d, e, w))
            in_adj[p_idx][d].append((s, e, w))

    node_pts = [Point(float(node_lon[i]), float(node_lat[i])) for i in range(n_nodes)]
    node_tree = STRtree(node_pts)

    bldg_pts = [Point(b["lon"], b["lat"]) for b in buildings]
    bldg_tree = STRtree(bldg_pts) if bldg_pts else None

    from_hub_prev_edge = np.full(3 * n_zones * n_nodes, SENTINEL_U16, dtype=np.uint16)
    to_hub_next_edge = np.full(3 * n_zones * n_nodes, SENTINEL_U16, dtype=np.uint16)
    bldg_assign: list[tuple[int, int, int]] = []  # (building index, zone idx, road node)
    assigned_buildings: set[int] = set()
    zones_out: list[dict[str, Any]] = []

    for z_idx, z in enumerate(zones_raw):
        poly_coords = [(float(p[1]), float(p[0])) for p in z["polygon"]]
        poly = Polygon(poly_coords)
        if not poly.is_valid:
            poly = make_valid(poly)
        cent = poly.centroid
        cent_lon, cent_lat = float(cent.x), float(cent.y)

        # Candidate SCC road nodes inside polygon; fallback to nearest nodes if empty
        cand_indices = [int(i) for i in node_tree.query(poly, predicate="intersects")]
        if not cand_indices:
            nearest_idx = int(node_tree.nearest(cent))
            cand_indices = [nearest_idx]

        def hub_score(nid: int) -> float:
            dlon = (float(node_lon[nid]) - cent_lon) * M_PER_DEG_LON
            dlat = (float(node_lat[nid]) - cent_lat) * M_PER_DEG_LAT
            dist_km = math.hypot(dlon, dlat) / 1000.0
            tri_bonus = 20.0 if tri_usable_incident[nid] else 0.0
            return float(node_max_kmh[nid]) + 4.0 * float(node_degree[nid]) + tri_bonus - 25.0 * dist_km

        hub_node = max(cand_indices, key=hub_score)

        # Order candidate nodes by closeness to centroid for uniform fallback
        cand_sorted = sorted(
            cand_indices,
            key=lambda nid: (
                (float(node_lon[nid]) - cent_lon) * M_PER_DEG_LON
            ) ** 2
            + ((float(node_lat[nid]) - cent_lat) * M_PER_DEG_LAT) ** 2,
        )

        # Map buildings inside this zone to nearest candidate road node inside the zone
        role_scores: dict[str, dict[int, float]] = {
            "home": defaultdict(float),
            "work": defaultdict(float),
            "school": defaultdict(float),
            "other": defaultdict(float),
        }
        if bldg_tree is not None:
            cand_pts = [node_pts[nid] for nid in cand_indices]
            cand_tree = STRtree(cand_pts)
            b_indices = bldg_tree.query(poly, predicate="intersects")
            for bi in b_indices:
                if int(bi) in assigned_buildings:
                    continue
                b = buildings[int(bi)]
                w_home, w_work, w_school, w_other = building_role_weights(b)
                if w_home <= 0.0 and w_work <= 0.0 and w_school <= 0.0 and w_other <= 0.0:
                    continue
                local_pos = int(cand_tree.nearest(bldg_pts[int(bi)]))
                nid = cand_indices[local_pos]
                assigned_buildings.add(int(bi))
                # Any node reaches the zone hub through the to-hub trees, so use the globally
                # nearest road node rather than only nodes inside the zone polygon.
                bldg_assign.append((int(bi), z_idx, int(node_tree.nearest(bldg_pts[int(bi)]))))
                if w_home > 0.0:
                    role_scores["home"][nid] += w_home
                if w_work > 0.0:
                    role_scores["work"][nid] += w_work
                if w_school > 0.0:
                    role_scores["school"][nid] += w_school
                if w_other > 0.0:
                    role_scores["other"][nid] += w_other

        access_nodes = {
            role: normalize_access_list(role_scores[role], cand_sorted)
            for role in ("home", "work", "school", "other")
        }

        unique_access = sorted(
            {int(entry[0]) for role_list in access_nodes.values() for entry in role_list}
        )

        # Shortest paths FROM hub_node (forward) and TO hub_node (reverse) for all 3 profiles
        to_hub_trees: list[np.ndarray] = []
        for p_idx in range(3):
            fwd_prev = dijkstra_tree(n_nodes, out_adj[p_idx], hub_node)
            offset = (p_idx * n_zones + z_idx) * n_nodes
            from_hub_prev_edge[offset : offset + n_nodes] = fwd_prev
            to_hub_trees.append(dijkstra_tree(n_nodes, in_adj[p_idx], hub_node))
            to_hub_next_edge[offset : offset + n_nodes] = to_hub_trees[p_idx]

        access_spurs: dict[str, list[list[int]]] = {}
        for nid in unique_access:
            access_spurs[str(nid)] = [
                trace_spur_edges(nid, hub_node, to_hub_trees[p_idx], edge_dst)
                for p_idx in range(3)
            ]

        zones_out.append(
            {
                "idx": z_idx,
                "id": str(z["id"]),
                "name": str(z["name"]),
                "centroid": [round(cent_lon, 6), round(cent_lat, 6)],
                "hub_node": int(hub_node),
                "pop": float(z.get("pop") or 0.0),
                "jobs": float(z.get("jobs") or 0.0),
                "students": float(z.get("students") or 0.0),
                "commerce": float(z.get("commerce") or 0.0),
                "access_nodes": access_nodes,
                "access_spurs": access_spurs,
            }
        )

    return zones_out, from_hub_prev_edge, bldg_assign, to_hub_next_edge


def write_mobility_network_bin(
    out_path: Path,
    node_lon: np.ndarray,
    node_lat: np.ndarray,
    node_elev: np.ndarray,
    edge_src: np.ndarray,
    edge_dst: np.ndarray,
    edge_len_km: np.ndarray,
    edge_capacity: np.ndarray,
    edge_t0_sec: np.ndarray,
    geom_offs: np.ndarray,
    geom_coords: np.ndarray,
    from_hub_prev_edge: np.ndarray,
    n_zones: int,
) -> None:
    """Write little-endian, 4-byte aligned mobility_network.bin."""
    n_nodes = len(node_lon)
    n_edges = len(edge_src)
    n_pts = len(geom_coords) // 2

    header = np.array(
        [MAGIC_BMOB, BINARY_VERSION, n_nodes, n_edges, n_pts, n_zones, 3, 0],
        dtype="<u4",
    )

    with out_path.open("wb") as fh:
        fh.write(header.tobytes())
        fh.write(np.asarray(node_lon, dtype="<f4").tobytes())
        fh.write(np.asarray(node_lat, dtype="<f4").tobytes())
        fh.write(np.asarray(node_elev, dtype="<f4").tobytes())

        fh.write(np.asarray(edge_src, dtype="<u2").tobytes())
        if n_edges % 2 == 1:
            fh.write(b"\x00\x00")
        fh.write(np.asarray(edge_dst, dtype="<u2").tobytes())
        if n_edges % 2 == 1:
            fh.write(b"\x00\x00")

        fh.write(np.asarray(edge_len_km, dtype="<f4").tobytes())
        fh.write(np.asarray(edge_capacity, dtype="<f4").tobytes())
        fh.write(np.asarray(edge_t0_sec, dtype="<f4").tobytes())
        fh.write(np.asarray(geom_offs, dtype="<u4").tobytes())
        fh.write(np.asarray(geom_coords, dtype="<f4").tobytes())

        fh.write(np.asarray(from_hub_prev_edge, dtype="<u2").tobytes())
        if len(from_hub_prev_edge) % 2 == 1:
            fh.write(b"\x00\x00")


def compute_zone_skims(
    zones_out: list[dict[str, Any]],
    from_hub_prev_edge: np.ndarray,
    edge_src: np.ndarray,
    edge_len_km: np.ndarray,
    edge_t0_sec: np.ndarray,
    n_nodes: int,
) -> dict[str, Any]:
    """Hub-to-hub road distance/time matrices from the existing hub shortest-path trees.

    od_km / od_min use the motorized profile (car free-flow time); od_walk_km the walk profile.
    Also returns nn_km: each zone's nearest-neighbour road distance (for intrazonal distance).
    Unreachable pairs get -1.
    """
    n_zones = len(zones_out)
    n_edges = len(edge_src)
    car_t0 = edge_t0_sec[3 * n_edges : 4 * n_edges]

    def trace(profile: int, z_from: int, node_to: int) -> list[int] | None:
        hub_from = zones_out[z_from]["hub_node"]
        base = (profile * n_zones + z_from) * n_nodes
        edges: list[int] = []
        cur = node_to
        guard = 0
        while cur != hub_from:
            e = int(from_hub_prev_edge[base + cur])
            if e == SENTINEL_U16 or guard > n_nodes:
                return None
            edges.append(e)
            cur = int(edge_src[e])
            guard += 1
        return edges

    od_km = [[-1.0] * n_zones for _ in range(n_zones)]
    od_min = [[-1.0] * n_zones for _ in range(n_zones)]
    od_walk = [[-1.0] * n_zones for _ in range(n_zones)]
    for i in range(n_zones):
        for j in range(n_zones):
            if i == j:
                od_km[i][j] = od_min[i][j] = od_walk[i][j] = 0.0
                continue
            hub_j = zones_out[j]["hub_node"]
            motor = trace(0, i, hub_j)
            if motor is not None:
                od_km[i][j] = round(float(sum(edge_len_km[e] for e in motor)), 3)
                od_min[i][j] = round(float(sum(car_t0[e] for e in motor)) / 60.0, 2)
            walk = trace(2, i, hub_j)
            if walk is not None:
                od_walk[i][j] = round(float(sum(edge_len_km[e] for e in walk)), 3)

    nn_km = []
    for i in range(n_zones):
        cands = [od_km[i][j] for j in range(n_zones) if j != i and od_km[i][j] > 0]
        nn_km.append(round(min(cands), 3) if cands else 1.0)
    return {"od_km": od_km, "od_min": od_min, "od_walk_km": od_walk, "nn_km": nn_km}


def compute_zone_building_aggregates(
    buildings: list[dict[str, Any]],
    bldg_assign: list[tuple[int, int, int]],
    n_zones: int,
) -> list[dict[str, Any]]:
    """Per zone: summed building role weights and weight-averaged centroid per role."""
    roles = ("home", "work", "school", "other")
    sums = [[0.0] * 4 for _ in range(n_zones)]
    lon_w = [[0.0] * 4 for _ in range(n_zones)]
    lat_w = [[0.0] * 4 for _ in range(n_zones)]
    for bi, z_idx, _nid in bldg_assign:
        b = buildings[bi]
        for k, w in enumerate(building_role_weights(b)):
            if w <= 0.0:
                continue
            sums[z_idx][k] += w
            lon_w[z_idx][k] += w * b["lon"]
            lat_w[z_idx][k] += w * b["lat"]
    out = []
    for z in range(n_zones):
        out.append(
            {
                "attr": {roles[k]: round(sums[z][k], 2) for k in range(4)},
                "centroid": {
                    roles[k]: [round(lon_w[z][k] / sums[z][k], 6), round(lat_w[z][k] / sums[z][k], 6)]
                    for k in range(4)
                    if sums[z][k] > 0.0
                },
            }
        )
    return out


def pad4(fh: Any, nbytes: int) -> None:
    rem = nbytes % 4
    if rem:
        fh.write(b"\x00" * (4 - rem))


def write_buildings_bin(
    out_path: Path,
    buildings: list[dict[str, Any]],
    bldg_assign: list[tuple[int, int, int]],
    to_hub_next_edge: np.ndarray,
    n_zones: int,
    n_nodes: int,
) -> list[str]:
    """Write mobility_buildings.bin; returns the building-class name table.

    Layout (little-endian, 4-byte aligned): header u32[8] = [magic, version, nBuildings,
    nZones, nNodes, nClasses, 0, 0]; zoneOffs u32[nZones+1]; lon/lat/area f32[n] each;
    node u16[n]; cls u8[n]; wHome/wWork/wSchool/wOther u16[n] (x64 fixed point);
    toHubNextEdge u16[3*nZones*nNodes]; gersId u8[16*n] (header word 6 == 1).
    Buildings are sorted by zone.
    """
    rows = sorted(bldg_assign, key=lambda r: (r[1], r[0]))
    n = len(rows)
    classes = sorted({buildings[bi]["bclass"] for bi, _, _ in rows})
    cls_idx = {c: i for i, c in enumerate(classes)}
    if len(classes) > 255:
        raise ValueError("too many building classes for u8")

    lon = np.zeros(n, dtype="<f4")
    lat = np.zeros(n, dtype="<f4")
    area = np.zeros(n, dtype="<f4")
    node = np.zeros(n, dtype="<u2")
    cls = np.zeros(n, dtype="u1")
    weights = np.zeros((4, n), dtype="<u2")
    zone_offs = np.zeros(n_zones + 1, dtype="<u4")
    for i, (bi, z_idx, nid) in enumerate(rows):
        b = buildings[bi]
        lon[i] = b["lon"]
        lat[i] = b["lat"]
        area[i] = b.get("area_m2", 40.0)
        node[i] = nid
        cls[i] = cls_idx[b["bclass"]]
        for k, w in enumerate(building_role_weights(b)):
            weights[k, i] = int(min(65535, round(w * WEIGHT_SCALE)))
        zone_offs[z_idx + 1] += 1
    zone_offs = np.cumsum(zone_offs).astype("<u4")

    header = np.array(
        [MAGIC_BBLD, BUILDINGS_VERSION, n, n_zones, n_nodes, len(classes), 1, 0], dtype="<u4"
    )
    with out_path.open("wb") as fh:
        fh.write(header.tobytes())
        fh.write(zone_offs.tobytes())
        fh.write(lon.tobytes())
        fh.write(lat.tobytes())
        fh.write(area.tobytes())
        fh.write(node.tobytes())
        pad4(fh, n * 2)
        fh.write(cls.tobytes())
        pad4(fh, n)
        for k in range(4):
            fh.write(weights[k].tobytes())
            pad4(fh, n * 2)
        fh.write(np.asarray(to_hub_next_edge, dtype="<u2").tobytes())
        pad4(fh, len(to_hub_next_edge) * 2)
        # GERS building ids as 16 raw UUID bytes each (zeros when the id is not a UUID);
        # header word 6 flags their presence.
        id_bytes = bytearray(16 * n)
        for i, (bi, _, _) in enumerate(rows):
            try:
                id_bytes[16 * i : 16 * i + 16] = uuid.UUID(str(buildings[bi].get("id") or "")).bytes
            except ValueError:
                pass
        fh.write(bytes(id_bytes))

    named: dict[str, list[str]] = {}
    for i, (bi, _, _) in enumerate(rows):
        b = buildings[bi]
        if b.get("name") or b.get("id"):
            if b.get("name"):
                named[str(i)] = [b.get("id", ""), b["name"]]
    out_path.with_suffix(".json").write_text(
        json.dumps({"classes": classes, "named": named}, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    return classes


POP_GRID_BLEND = 0.5  # 0 = footprint-based home weights only, 1 = fully follow the population grid
POP_FACTOR_CLIP = (0.2, 5.0)  # keep one noisy cell from dominating a barangay
SIGNAL_DELAY_SEC = 20.0  # expected wait at a signalised junction (about half a typical cycle x P(red))
SIGNAL_SNAP_M = 25.0


def population_home_factors(
    cell_idx: np.ndarray,
    home_w: np.ndarray,
    cell_pop: np.ndarray,
    cell_barangay: np.ndarray,
    psa_pop: np.ndarray,
    blend: float = POP_GRID_BLEND,
) -> tuple[np.ndarray, dict[str, float]]:
    """Per-building multiplier for home weights from a gridded population surface.

    cell_idx      grid cell of each building (-1 outside the grid)
    home_w        each building's base home weight (0 for non-residential)
    cell_pop      raw grid population per cell
    cell_barangay barangay index of each cell (-1 outside the city)
    psa_pop       PSA 2020 population per barangay; the grid is rescaled to these totals

    A cell's density is its (rescaled) population per unit of home weight; the factor compares it with
    the barangay average, blended with 1 and clipped. The grid only redistributes people between cells
    of one barangay, so barangay totals still come from PSA.
    """
    n_cells = len(cell_pop)
    nb = len(psa_pop)
    inside = cell_barangay >= 0
    raw_total = np.bincount(cell_barangay[inside], weights=cell_pop[inside], minlength=nb)
    scale = np.where(raw_total > 0, psa_pop / np.where(raw_total > 0, raw_total, 1.0), 1.0)
    pop = np.where(inside, cell_pop * scale[np.where(inside, cell_barangay, 0)], 0.0)

    ok = cell_idx >= 0
    cell_w = np.bincount(cell_idx[ok], weights=home_w[ok], minlength=n_cells)
    housed = inside & (cell_w > 0)
    housed_pop = np.bincount(cell_barangay[housed], weights=pop[housed], minlength=nb)
    housed_w = np.bincount(cell_barangay[housed], weights=cell_w[housed], minlength=nb)
    mean_density = np.where(housed_w > 0, housed_pop / np.where(housed_w > 0, housed_w, 1.0), 0.0)

    density = np.where(housed, pop / np.where(cell_w > 0, cell_w, 1.0), 0.0)
    rel = np.ones(n_cells)
    ref = mean_density[np.where(inside, cell_barangay, 0)]
    use = housed & (ref > 0)
    rel[use] = np.clip(density[use] / ref[use], POP_FACTOR_CLIP[0], POP_FACTOR_CLIP[1])
    factors = np.ones(len(cell_idx))
    sel = ok & (home_w > 0)
    factors[sel] = (1.0 - blend) + blend * rel[cell_idx[sel]]

    total = float(pop.sum())
    stats = {
        "unplaced_share": float(pop[inside & ~housed].sum() / total) if total > 0 else 0.0,
        "factor_min": float(factors[sel].min()) if sel.any() else 1.0,
        "factor_max": float(factors[sel].max()) if sel.any() else 1.0,
        "factor_mean": float(factors[sel].mean()) if sel.any() else 1.0,
    }
    return factors, stats


def read_ascii_grid(path: Path) -> tuple[np.ndarray, float, float, float]:
    """Parse an Esri ASCII grid: (array[row, col] with nodata -> 0, west, north, cell size)."""
    header: dict[str, float] = {}
    with path.open() as fh:
        for _ in range(6):
            k, v = fh.readline().split()
            header[k.lower()] = float(v)
        data = np.loadtxt(fh)
    nodata = header.get("nodata_value", -9999.0)
    data = np.where(data == nodata, 0.0, np.clip(data, 0.0, None))
    cs = header["cellsize"]
    return data, header["xllcorner"], header["yllcorner"] + header["nrows"] * cs, cs


def apply_population_grid(
    buildings: list[dict[str, Any]],
    grid_tif: Path,
    boundaries_path: Path,
    demographics_path: Path,
    blend: float = POP_GRID_BLEND,
) -> dict[str, float] | None:
    """Set `home_factor` on each building record from a WorldPop-style 100 m grid (see
    population_home_factors). Returns stats, or None when an input file is missing."""
    import subprocess

    if not (grid_tif.exists() and boundaries_path.exists() and demographics_path.exists()):
        return None
    from shapely import points as shp_points
    from shapely.geometry import shape

    fc = json.loads(boundaries_path.read_text(encoding="utf-8"))
    brgys = [(f["properties"]["name"], shape(f["geometry"])) for f in fc["features"] if f["properties"].get("level") == "barangay"]
    demo = json.loads(demographics_path.read_text(encoding="utf-8"))["barangays"]
    names = [n for n, _ in brgys]
    psa = np.array([float(demo.get(n, {}).get("population", 0.0)) for n in names])

    west, south, east, north = PLACE.analysis_bbox
    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_pop_") as d:
        clip = Path(d) / "clip.asc"
        subprocess.run(
            ["gdal_translate", "-q", "-of", "AAIGrid", "-projwin", str(west), str(north), str(east), str(south), str(grid_tif), str(clip)],
            check=True,
        )
        grid, gw, gn, cs = read_ascii_grid(clip)
    nrows, ncols = grid.shape

    xs = gw + (np.arange(ncols) + 0.5) * cs
    ys = gn - (np.arange(nrows) + 0.5) * cs
    gx, gy = np.meshgrid(xs, ys)
    centers = shp_points(gx.ravel(), gy.ravel())
    cell_barangay = np.full(nrows * ncols, -1, dtype=np.int64)
    tree = STRtree([g for _, g in brgys])
    ci, bi = tree.query(centers, predicate="within")
    cell_barangay[ci] = bi

    lon = np.array([b["lon"] for b in buildings])
    lat = np.array([b["lat"] for b in buildings])
    col = np.floor((lon - gw) / cs).astype(np.int64)
    row = np.floor((gn - lat) / cs).astype(np.int64)
    ok = (col >= 0) & (col < ncols) & (row >= 0) & (row < nrows)
    cell_idx = np.where(ok, row * ncols + col, -1)
    home_w = np.array([building_role_weights(b)[0] for b in buildings])

    factors, stats = population_home_factors(cell_idx, home_w, grid.ravel(), cell_barangay, psa, blend)
    for b, f in zip(buildings, factors):
        b["home_factor"] = float(f)
    stats["blend"] = blend
    stats["grid_total_in_city"] = float(grid.ravel()[cell_barangay >= 0].sum())
    stats["psa_total"] = float(psa.sum())
    return stats


def apply_signal_delay(
    edge_t0_sec: np.ndarray,
    edge_dst: np.ndarray,
    node_lon: np.ndarray,
    node_lat: np.ndarray,
    signals: list[list[float]],
    n_edges: int,
    delay_sec: float = SIGNAL_DELAY_SEC,
) -> int:
    """Add a fixed delay to motorised free-flow times of edges that end at a signalised node.

    Signals are OSM highway=traffic_signals nodes snapped to the nearest graph node within SIGNAL_SNAP_M.
    Walking is unaffected. Modifies `edge_t0_sec` in place (mode blocks: walk, motorcycle, tricycle, car,
    puv) and returns the number of graph nodes treated as signalised.
    """
    if not signals or len(node_lon) == 0:
        return 0
    lat0 = float(np.mean(node_lat))
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 110_540.0
    nx = node_lon.astype(np.float64) * kx
    ny = node_lat.astype(np.float64) * ky
    signalised = np.zeros(len(node_lon), dtype=bool)
    for lon, lat in signals:
        d = np.hypot(nx - lon * kx, ny - lat * ky)
        j = int(np.argmin(d))
        if d[j] <= SIGNAL_SNAP_M:
            signalised[j] = True
    hit = signalised[edge_dst.astype(np.int64)]
    for block in range(1, 5):
        edge_t0_sec[block * n_edges : (block + 1) * n_edges] += np.where(hit, delay_sec, 0.0).astype(np.float32)
    return int(signalised.sum())


def attach_zone_demand(
    zones: list[dict[str, Any]],
    demand: dict[str, Any] | None,
    typology: dict[str, Any] | None,
) -> int:
    """Add per-purpose trip production, purpose mix and area type to zones matched by name.

    Returns the number of zones that received demand data. Missing files leave zones unchanged,
    and the simulation then falls back to population-proportional production.
    """
    matched = 0
    for zone in zones:
        name = str(zone.get("name"))
        d = ((demand or {}).get("barangays") or {}).get(name)
        if d:
            zone["prod"] = d["prod"]
            zone["purpose_mix"] = d["mix"]
            matched += 1
        t = ((typology or {}).get("barangays") or {}).get(name)
        if t:
            zone["area_type"] = {"key": t["type"], "label": t["label"]}
    return matched


def _load_optional_json(path: Path) -> dict[str, Any] | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def export_trafficsim_network(
    state_dir: Path,
    buildings_pmtiles: Path,
    building_pois_path: Path,
    dem_manifest_path: Path,
    out_dir: Path,
) -> dict[str, Any]:
    """Run the full trafficsim + Digital Twin export pipeline."""
    state_npz_path = state_dir / "state.npz"
    state_json_path = state_dir / "state.json"

    npz = np.load(state_npz_path, allow_pickle=True)
    state_json = json.loads(state_json_path.read_text(encoding="utf-8"))

    is_zone = npz["is_zone"].astype(bool)
    raw_src = npz["src"].astype(np.int64)
    raw_dst = npz["dst"].astype(np.int64)
    raw_lat = npz["lat"].astype(np.float64)
    raw_lon = npz["lon"].astype(np.float64)
    raw_length = npz["length"].astype(np.float64)
    raw_capacity = (
        npz["capacity"].astype(np.float64)
        if "capacity" in npz.files
        else np.full(len(raw_src), 1200.0, dtype=np.float64)
    )
    raw_g_offs = npz["g_offs"].astype(np.int64)
    raw_g_coords = ensure_lon_lat_coords(npz["g_coords"])

    # Road edges usable by AT LEAST ONE profile define the SCC. Requiring every profile dropped
    # ~17 % of nodes (e.g. Burgos Extension east of the centre, whose junctions with fast
    # arterials are tricycle-banned), so whole corridors vanished and traffic detoured. Profiles
    # that cannot use a node simply see it as unreachable (the sim treats that mode as infeasible).
    road_mask = ~(is_zone[raw_src] | is_zone[raw_dst])
    usable_car = npz["t0:car"] < BANNED_T0_MIN
    usable_tri = npz["t0:tricycle"] < BANNED_T0_MIN
    usable_walk = npz["t0:walk"] < BANNED_T0_MIN
    usable_any_scc = road_mask & (usable_car | usable_tri | usable_walk)

    scc_nodes = compute_largest_scc(len(is_zone), raw_src[usable_any_scc], raw_dst[usable_any_scc])
    n_nodes = len(scc_nodes)
    if n_nodes >= MAX_U16_COUNT:
        raise ValueError(f"SCC node count {n_nodes} exceeds Uint16 limit {MAX_U16_COUNT}")

    old_to_new = np.full(len(is_zone), -1, dtype=np.int32)
    old_to_new[scc_nodes] = np.arange(n_nodes, dtype=np.int32)

    # Keep all road edges inside SCC usable by at least one profile (preserves highway links
    # where tricycle has a large arterial penalty while car/moto/puv remain fast)
    usable_any = road_mask & (usable_car | usable_tri | usable_walk)
    in_scc_edge = (
        usable_any
        & (old_to_new[raw_src] >= 0)
        & (old_to_new[raw_dst] >= 0)
    )
    kept_edge_indices = np.where(in_scc_edge)[0]
    n_edges = len(kept_edge_indices)
    if n_edges >= MAX_U16_COUNT:
        raise ValueError(f"SCC edge count {n_edges} exceeds Uint16 limit {MAX_U16_COUNT}")

    node_lon = raw_lon[scc_nodes].astype(np.float32)
    node_lat = raw_lat[scc_nodes].astype(np.float32)

    dem_sampler: Callable[[float, float], float | None] = load_dem_sampler(dem_manifest_path)
    node_elev = np.zeros(n_nodes, dtype=np.float32)
    for i in range(n_nodes):
        elev = dem_sampler(float(node_lon[i]), float(node_lat[i]))
        node_elev[i] = float(elev) if elev is not None and math.isfinite(elev) else 0.0

    edge_src = old_to_new[raw_src[kept_edge_indices]].astype(np.uint16)
    edge_dst = old_to_new[raw_dst[kept_edge_indices]].astype(np.uint16)
    edge_len_km = raw_length[kept_edge_indices].astype(np.float32)
    cap_kept = raw_capacity[kept_edge_indices]
    edge_capacity = np.where(
        np.isfinite(cap_kept) & (cap_kept > 0.0), cap_kept, 800.0
    ).astype(np.float32)

    # Convert t0 from minutes -> seconds in mode order: walk, motorcycle, tricycle, car, puv
    edge_t0_sec = np.empty(5 * n_edges, dtype=np.float32)
    for m_idx, mode_id in enumerate(MODE_ORDER):
        t0_min = npz[f"t0:{mode_id}"][kept_edge_indices]
        edge_t0_sec[m_idx * n_edges : (m_idx + 1) * n_edges] = (t0_min * 60.0).astype(np.float32)

    transport = _load_optional_json(out_dir / "transport_osm.json")
    n_signal_nodes = apply_signal_delay(
        edge_t0_sec, edge_dst, node_lon, node_lat, (transport or {}).get("signals", []), n_edges
    )
    print(f"Signal delay ({SIGNAL_DELAY_SEC:.0f} s) applied at {n_signal_nodes} signalised junctions")

    edge_usable_mask = np.vstack(
        [
            usable_car[kept_edge_indices],
            usable_tri[kept_edge_indices],
            usable_walk[kept_edge_indices],
        ]
    )

    # Slice and compact geometry coordinates
    geom_offs = np.zeros(n_edges + 1, dtype=np.uint32)
    geom_slices: list[np.ndarray] = []
    pt_cursor = 0
    for new_e, old_e in enumerate(kept_edge_indices.tolist()):
        g0 = int(raw_g_offs[old_e])
        g1 = int(raw_g_offs[old_e + 1])
        pts = raw_g_coords[g0:g1]
        geom_slices.append(pts)
        pt_cursor += len(pts)
        geom_offs[new_e + 1] = pt_cursor

    geom_coords = (
        np.concatenate(geom_slices, axis=0).astype(np.float32).reshape(-1)
        if geom_slices
        else np.zeros(0, dtype=np.float32)
    )
    n_pts = pt_cursor

    buildings = extract_building_points(buildings_pmtiles, building_pois_path)
    pop_stats = apply_population_grid(
        buildings,
        REPO_ROOT / "data" / "popgrid" / "phl_pop_2020_CN_100m_R2025A_v1.tif",
        out_dir / "boundaries.geojson",
        out_dir / "barangay_demographics.json",
    )
    if pop_stats:
        print(
            "Population grid applied: WorldPop in city {grid_total_in_city:,.0f} vs PSA {psa_total:,.0f}; "
            "unplaced {unplaced_share:.1%}; home factor min {factor_min:.2f} mean {factor_mean:.2f} max {factor_max:.2f}".format(**pop_stats)
        )
    zones_raw = state_json["zones"]
    zones_out, from_hub_prev_edge, bldg_assign, to_hub_next_edge = build_zones_and_trees(
        zones_raw=zones_raw,
        node_lon=node_lon,
        node_lat=node_lat,
        edge_src=edge_src,
        edge_dst=edge_dst,
        edge_len_km=edge_len_km,
        edge_t0_sec=edge_t0_sec,
        edge_usable_mask=edge_usable_mask,
        buildings=buildings,
    )

    # Build mode metadata matching state.json mode_cfg + modes
    mode_cfg_map = {m["id"]: m for m in state_json["mode_cfg"]}
    modes_dict = state_json.get("modes", {})
    default_b_cost = float(state_json.get("b_cost", -0.04))
    default_b_dur = float(state_json.get("b_dur", -0.05))
    modes_out: list[dict[str, Any]] = []
    for mode_id in MODE_ORDER:
        cfg = mode_cfg_map[mode_id]
        m_extra = modes_dict.get(mode_id, {})
        phys = MODE_PHYSICS[mode_id]
        modes_out.append(
            {
                "id": mode_id,
                "name": str(cfg["name"]),
                "color": MODE_COLORS[mode_id],
                "asc": float(cfg["asc"]),
                "beta_cost": float(m_extra.get("beta_cost", default_b_cost)),
                "beta_duration": float(m_extra.get("beta_duration", default_b_dur)),
                "cost_per_km": float(cfg["cost_per_km"]),
                "target_share": float(cfg["target"]),
                "occupancy_min": int(phys["occupancy_min"]),
                "occupancy_max": int(phys["occupancy_max"]),
                "pcu": float(phys["pcu"]),
                "congests": bool(phys["congests"]),
                "lane_filter": float(phys["lane_filter"]),
            }
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / "mobility_network.bin"
    zones_path = out_dir / "mobility_zones.json"

    write_mobility_network_bin(
        out_path=bin_path,
        node_lon=node_lon,
        node_lat=node_lat,
        node_elev=node_elev,
        edge_src=edge_src,
        edge_dst=edge_dst,
        edge_len_km=edge_len_km,
        edge_capacity=edge_capacity,
        edge_t0_sec=edge_t0_sec,
        geom_offs=geom_offs,
        geom_coords=geom_coords,
        from_hub_prev_edge=from_hub_prev_edge,
        n_zones=len(zones_out),
    )

    write_buildings_bin(
        out_path=out_dir / "mobility_buildings.bin",
        buildings=buildings,
        bldg_assign=bldg_assign,
        to_hub_next_edge=to_hub_next_edge,
        n_zones=len(zones_out),
        n_nodes=n_nodes,
    )

    skims = compute_zone_skims(
        zones_out, from_hub_prev_edge, edge_src, edge_len_km, edge_t0_sec, n_nodes
    )
    bld_agg = compute_zone_building_aggregates(buildings, bldg_assign, len(zones_out))
    for z_idx, zone in enumerate(zones_out):
        zone["nn_km"] = skims["nn_km"][z_idx]
        zone["bldg_attr"] = bld_agg[z_idx]["attr"]
        zone["bldg_centroid"] = bld_agg[z_idx]["centroid"]

    n_demand = attach_zone_demand(
        zones_out,
        _load_optional_json(out_dir / "barangay_demand.json"),
        _load_optional_json(out_dir / "barangay_typology.json"),
    )
    print(f"Per-purpose demand attached to {n_demand}/{len(zones_out)} zones")

    zones_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "trafficsim_map",
        "n_nodes": int(n_nodes),
        "n_edges": int(n_edges),
        "n_pts": int(n_pts),
        "modes": modes_out,
        "purposes": state_json["econ"]["purposes"],
        "routing_profiles": ROUTING_PROFILES,
        "mode_profile_map": MODE_PROFILE_MAP,
        "skims": {k: skims[k] for k in ("od_km", "od_min", "od_walk_km")},
        # Survey-derived demand anchors (JICA Metro Cebu HIS 2014 rate, trafficsim economy params)
        "demand": {
            "population": float(sum(float(z.get("pop") or 0.0) for z in zones_raw)),
            "trips_per_person": float(state_json["econ"].get("trips_per_person", 2.97)),
            "peak_share": float(state_json["econ"].get("peak_share", 0.09)),
        },
        "population_grid": pop_stats,
        "zones": zones_out,
    }
    zones_path.write_text(json.dumps(zones_payload, separators=(",", ":")), encoding="utf-8")

    return {
        "n_nodes": n_nodes,
        "n_edges": n_edges,
        "n_pts": n_pts,
        "n_zones": len(zones_out),
        "n_buildings": len(bldg_assign),
        "bin_bytes": bin_path.stat().st_size,
        "json_bytes": zones_path.stat().st_size,
        "unreachable_count": int(
            np.sum(from_hub_prev_edge == SENTINEL_U16) - 3 * len(zones_out)
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export trafficsim_map network & Digital Twin access nodes."
    )
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--buildings-pmtiles", type=Path, default=DEFAULT_BUILDINGS_PMTILES)
    parser.add_argument("--building-pois", type=Path, default=DEFAULT_BUILDING_POIS)
    parser.add_argument("--dem-manifest", type=Path, default=DEFAULT_DEM_MANIFEST)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    add_place_argument(parser)
    args = parser.parse_args()

    summary = export_trafficsim_network(
        state_dir=args.state_dir,
        buildings_pmtiles=args.buildings_pmtiles,
        building_pois_path=args.building_pois,
        dem_manifest_path=args.dem_manifest,
        out_dir=args.out_dir,
    )
    print(
        f"Exported mobility network: {summary['n_nodes']} nodes, {summary['n_edges']} edges, "
        f"{summary['n_pts']} geom pts, {summary['n_zones']} zones | "
        f"bin={summary['bin_bytes']:,} B, json={summary['json_bytes']:,} B, "
        f"unreachable={summary['unreachable_count']}"
    )


if __name__ == "__main__":
    main()
