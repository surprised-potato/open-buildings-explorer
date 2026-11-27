# File: server/project.py
"""Server-side project: array network + road geometry + zones + OD, built on engine/*."""
import json
import math
import threading
from typing import Dict, List, Optional

import numpy as np

import osm_import
from data_structures import Mode
from engine.network import FastNetwork
from engine import zones as zone_tools, od as od_tools
from geometry import polygon_area_km2
from server import economy
import copy

CONNECTOR_SPEED_KMH = 30.0
CONNECTOR_CAP = 20000.0      # abstract link: it must not become the bottleneck, the real roads behind it should
MAX_CONNECTORS = 12
CLOSED_T = 1e6        # travel time of a closed road: pairs that need it become 'unreachable'


def default_modes() -> Dict[str, Mode]:
    return {"car": Mode(id="car", name="Car", beta_cost=-0.05, beta_duration=-0.05)}


class Project:
    def __init__(self):
        self.lock = threading.RLock()
        self.net: Optional[FastNetwork] = None
        self.geom: List[Optional[np.ndarray]] = []     # per edge: (k,2) array of (lon, lat) or None
        self.modes: Dict[str, Mode] = default_modes()
        self.zones: List[dict] = []                    # {id,name,polygon[(lat,lon)],node_id}
        self.od: Dict[str, Dict[str, float]] = {}
        self.flows: Optional[Dict[str, np.ndarray]] = None
        self.times: Optional[Dict[str, np.ndarray]] = None
        self.version = 0
        self.name = "empty"
        self.boundary = []
        self.closed: set = set()
        self.econ = copy.deepcopy(economy.ECON_DEFAULTS)      # economic demand-model parameters
        self.econ_summary = None
        self.od_purpose: dict = {}
        self.mode_cfg = None                           # None = single 'car' mode; else list of mode dicts
        self.b_cost, self.b_dur = economy.DEFAULT_B_COST, economy.DEFAULT_B_DUR
        self.mode_trips: dict = {}
        self.mode_by_zone: dict = {}                   # zone id -> {mode: person trips} from the last assignment
        self.struct = 0                                # bumps whenever geometry/zones change (viewer reload trigger)
        self.od_params = None                          # (total, beta) when OD came from the gravity model
        self.undo_stack: list = []
        self.redo_stack: list = []

    # ---- loading ---------------------------------------------------------------
    def set_network(self, net: FastNetwork, geom, name: str):
        with self.lock:
            self.net, self.geom, self.name = net, geom, name
            self.zones, self.od, self.flows, self.times = [], {}, None, None
            self.boundary = []
            self.closed, self.undo_stack, self.redo_stack = set(), [], []
            self.econ["enabled"], self.econ_summary, self.od_purpose, self.mode_by_zone = False, None, {}, {}
            if self.mode_cfg is not None:                 # a new city starts with the single default mode
                self.mode_cfg, self.modes = None, default_modes()
            self.struct += 1
            self.version += 1

    def load_objects(self, nodes, edges, name="import"):
        """From osm_import.Node/Edge lists (+ optional existing zone nodes)."""
        mid = next(iter(self.modes))
        idx = {n.id: i for i, n in enumerate(nodes)}
        edges = [e for e in edges if e.start_node_id in idx and e.end_node_id in idx]
        t0 = np.array([e.free_flow_time if e.free_flow_time else e.distance / 30 * 60 for e in edges], float)
        net = FastNetwork([n.id for n in nodes], [n.lat for n in nodes], [n.lon for n in nodes],
                          [n.is_zone for n in nodes], [e.id for e in edges],
                          [idx[e.start_node_id] for e in edges], [idx[e.end_node_id] for e in edges],
                          [e.distance for e in edges], [e.capacity for e in edges],
                          {mid: t0}, {mid: np.array([e.distance for e in edges], float)}, t0_ref=t0)
        geom = [np.array([(p[1], p[0]) for p in e.geometry], float) if e.geometry else None for e in edges]
        self.set_network(net, geom, name)

    def load_sim_json(self, path: str):
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        from data_structures import Node, Edge
        nodes = [Node(id=n["id"], lat=n["lat"], lon=n["lon"], name=n.get("name", n["id"]), is_zone=n.get("is_zone", False))
                 for n in d.get("nodes", [])]
        edges = [Edge(id=e["id"], start_node_id=e["start_node_id"], end_node_id=e["end_node_id"],
                      distance=e.get("distance", 1.0), capacity=e.get("capacity", 1000.0),
                      free_flow_time=e.get("free_flow_time"), geometry=e.get("geometry")) for e in d.get("edges", [])]
        self.modes = {k: Mode(**v) for k, v in d.get("modes", {}).items()} or default_modes()
        self.load_objects(nodes, edges, name=path.split("/")[-1])
        byid = {n.id: n for n in nodes}
        self.zones = [{"id": p["id"], "name": p["name"], "polygon": [tuple(x) for x in p["points"]],
                       "node_id": p["zone_node_id"]} for p in d.get("polygons", []) if p.get("zone_node_id") in byid]
        known = {z["node_id"] for z in self.zones}
        for n in nodes:
            if n.is_zone and n.id not in known:
                self.zones.append({"id": n.id, "name": n.name, "polygon": [], "node_id": n.id})
        self.od = d.get("od_matrix", {})

    # ---- edge edits (delta undo/redo) ----------------------------------------------
    def _snapshot(self, ids):
        n = self.net
        return {"ids": list(ids), "cap": n.capacity[ids].copy(), "ref": n.t0_ref[ids].copy(),
                "t0": {m: a[ids].copy() for m, a in n.t0.items()}, "closed": [int(i) in self.closed for i in ids]}

    def _restore(self, snap):
        n, ids = self.net, snap["ids"]
        n.capacity[ids] = snap["cap"]; n.t0_ref[ids] = snap["ref"]
        for m, a in snap["t0"].items():
            n.t0[m][ids] = a
        for i, c in zip(ids, snap["closed"]):
            (self.closed.add if c else self.closed.discard)(int(i))

    def edit_edges(self, ids, capacity=None, speed_kmh=None, closed=None) -> int:
        with self.lock:
            n = self.net
            ids = np.unique(np.asarray(ids, dtype=int))
            if len(ids) == 0 or ids.min() < 0 or ids.max() >= n.n_edges:
                raise ValueError("edge index out of range")
            if capacity is not None and capacity <= 0:
                raise ValueError("capacity must be positive")
            if speed_kmh is not None and speed_kmh <= 0:
                raise ValueError("speed must be positive")
            before = self._snapshot(ids)
            if capacity is not None:
                n.capacity[ids] = capacity
            if speed_kmh is not None:
                new_ref = np.maximum(n.length[ids] / speed_kmh * 60.0, 1e-4)
                ratio = new_ref / n.t0_ref[ids]
                for m in n.t0:
                    n.t0[m][ids] = np.where(n.t0[m][ids] >= CLOSED_T, n.t0[m][ids], n.t0[m][ids] * ratio)
                n.t0_ref[ids] = new_ref
            if closed is not None:
                for i in ids:
                    (self.closed.add if closed else self.closed.discard)(int(i))
                for m in n.t0:
                    n.t0[m][ids] = CLOSED_T if closed else n.t0_ref[ids]
            self.undo_stack.append(("e", before, self._snapshot(ids)))
            del self.undo_stack[:-200]
            self.redo_stack.clear()
            self._touch()
            return len(ids)

    def _touch(self):
        self.flows = self.times = None
        self.version += 1

    # whole-state snapshots (zone operations build NEW network objects, so references are enough)
    def _state(self):
        return {"net": self.net, "geom": self.geom, "zones": [dict(z) for z in self.zones], "od": self.od,
                "closed": set(self.closed), "od_params": self.od_params}

    def _set_state(self, st):
        self.net, self.geom, self.zones, self.od = st["net"], st["geom"], [dict(z) for z in st["zones"]], st["od"]
        self.closed, self.od_params = set(st["closed"]), st["od_params"]

    def _apply(self, entry, undo: bool):
        kind, before, after = entry
        if kind == "e":
            self._restore(before if undo else after)
        else:
            self._set_state(before if undo else after)

    def undoable(self, fn):
        """Run a zone operation and make it one undo step."""
        with self.lock:
            before = self._state()
            r = fn()
            self.struct += 1
            self.undo_stack.append(("s", before, self._state()))
            del self.undo_stack[:-100]
            self.redo_stack.clear()
            self._touch()
            return r

    def undo(self) -> bool:
        with self.lock:
            if not self.undo_stack:
                return False
            e = self.undo_stack.pop()
            self.struct += e[0] == "s"
            self._apply(e, True); self.redo_stack.append(e); self._touch()
            return True

    def redo(self) -> bool:
        with self.lock:
            if not self.redo_stack:
                return False
            e = self.redo_stack.pop()
            self.struct += e[0] == "s"
            self._apply(e, False); self.undo_stack.append(e); self._touch()
            return True

    # ---- zones -----------------------------------------------------------------
    def bbox(self):
        n = self.net
        return (float(n.lat.min()), float(n.lon.min()), float(n.lat.max()), float(n.lon.max()))

    def add_zones(self, specs: List[dict], k: int = 2) -> int:
        """specs: [{name, polygon[(lat,lon)]}] -> zone node at centroid + k connectors both ways."""
        with self.lock:
            net, mid = self.net, next(iter(self.modes))
            lat, lon, zone = list(net.lat), list(net.lon), list(net.is_zone)
            ids = list(net.node_ids)
            src, dst = list(net.src), list(net.dst)
            eids = list(net.edge_ids)
            length, cap = list(net.length), list(net.capacity)
            t0, cost, t0r = list(net.t0[mid]), list(net.cost[mid]), list(net.t0_ref)
            geom = list(self.geom)
            added = 0
            for spec in specs:
                poly = spec["polygon"]
                c = osm_import.polygon_centroid(poly)
                zi = len(ids)
                used = {z["id"] for z in self.zones} | set(ids)
                num = len(self.zones) + added + 1
                while f"zone{num}" in used:
                    num += 1
                zid = f"zone{num}"
                ids.append(zid); lat.append(c[0]); lon.append(c[1]); zone.append(True)
                for r in self._targets(net, c, poly, spec.get("pop")):
                    d = max(osm_import.haversine_km(c[0], c[1], net.lat[r], net.lon[r]), 0.001)
                    tt = max(d / CONNECTOR_SPEED_KMH * 60, 0.05)
                    for a, b in ((zi, int(r)), (int(r), zi)):
                        src.append(a); dst.append(b); eids.append(f"c{len(eids)}"); length.append(d)
                        cap.append(CONNECTOR_CAP); t0.append(tt); cost.append(d); t0r.append(tt)
                        pa = (lon[a], lat[a]) if a < len(lon) else None
                        geom.append(None)
                self.zones.append({"id": zid, "name": spec.get("name", zid), "polygon": [tuple(p) for p in poly], "node_id": zid})
                added += 1
            self.net = FastNetwork(ids, lat, lon, zone, eids, src, dst, length, cap, {mid: t0}, {mid: cost}, t0_ref=t0r)
            self.geom = geom
            self.flows = self.times = None
            self.version += 1
            return added

    def connector_count(self, polygon, pop=None) -> int:
        """Entry points per zone: grows with population (or, without census data, with the number of road nodes inside)."""
        if pop:
            n = 2 + int(math.sqrt(pop / 1500.0))
        elif polygon:
            la = [p[0] for p in polygon]; lo = [p[1] for p in polygon]
            net = self.net
            road = ~net.is_zone
            cnt = int((road & (net.lat >= min(la)) & (net.lat <= max(la)) & (net.lon >= min(lo)) & (net.lon <= max(lo))).sum())
            n = 2 + int(math.sqrt(cnt / 40.0))
        else:
            n = 2
        return max(2, min(MAX_CONNECTORS, n))

    def _targets(self, net, centroid, polygon, pop=None):
        speeds = getattr(net, "_node_speeds", None)
        if speeds is None:
            speeds = net._node_speeds = zone_tools.node_speeds(net)
        return zone_tools.spread_targets(net, centroid, polygon, self.connector_count(polygon, pop), speeds=speeds, hierarchical=True)

    def snap_node(self, lat: float, lon: float, max_m: float):
        """Nearest road node within max_m, as (index, lat, lon) or None."""
        i = int(self.net.nearest_nodes(lat, lon, k=1, road_only=True)[0])
        d = osm_import.haversine_km(lat, lon, float(self.net.lat[i]), float(self.net.lon[i])) * 1000
        return (i, float(self.net.lat[i]), float(self.net.lon[i])) if d <= max_m else None

    def add_road(self, points, speed_kmh: float, capacity: float, two_way: bool = True, snap_m: float = 20.0) -> dict:
        """points: [(lat, lon), ...]. Points within snap_m of an existing road node attach there (junctions);
        first/last points become nodes (new if not snapped), other points become the road's shape."""
        with self.lock:
            net = self.net
            pts = [(float(a), float(b)) for a, b in points]
            if len(pts) < 2:
                raise ValueError("A road needs at least 2 points")
            lat, lon, zone, ids = list(net.lat), list(net.lon), list(net.is_zone), list(net.node_ids)
            src, dst, eids = list(net.src), list(net.dst), list(net.edge_ids)
            length, cap = list(net.length), list(net.capacity)
            t0 = {m: list(a) for m, a in net.t0.items()}
            cost = {m: list(a) for m, a in net.cost.items()}
            t0r = list(net.t0_ref)
            geom = list(self.geom)
            # resolve each point -> (node index or None, lat, lon)
            res = []
            for k, (la, lo) in enumerate(pts):
                sn = self.snap_node(la, lo, snap_m)
                res.append(sn if sn else (None, la, lo))
            res[0] = res[0] if res[0][0] is not None else (None,) + res[0][1:]
            cut = [k for k, r in enumerate(res) if r[0] is not None or k in (0, len(res) - 1)]
            new_nodes = 0
            def node_for(k):
                nonlocal new_nodes
                i, la, lo = res[k]
                if i is not None:
                    return int(i)
                new_nodes += 1
                nid = f"web{len(ids)}"
                while nid in net.node_index or nid in ids[len(net.node_ids):]:
                    nid += "x"
                ids.append(nid); lat.append(la); lon.append(lo); zone.append(False)
                res[k] = (len(ids) - 1, la, lo)
                return len(ids) - 1
            nodes = {k: node_for(k) for k in cut}
            added = 0
            base = f"w{len(eids)}"
            for a, b in zip(cut, cut[1:]):
                u, v = nodes[a], nodes[b]
                if u == v:
                    continue
                shape = [(res[k][1], res[k][2]) for k in range(a, b + 1)]
                shape[0] = (lat[u], lon[u]); shape[-1] = (lat[v], lon[v])
                L = max(osm_import.polyline_length_km(shape), 0.001)
                tt = L / speed_kmh * 60.0
                dirs = [(u, v, shape)] + ([(v, u, shape[::-1])] if two_way else [])
                for x, y, sh in dirs:
                    src.append(x); dst.append(y); eids.append(f"{base}_{len(eids)}"); length.append(L); cap.append(capacity)
                    for m in t0:
                        t0[m].append(tt); cost[m].append(L)
                    t0r.append(tt)
                    geom.append(np.array([(p[1], p[0]) for p in sh], float))
                    added += 1
            if not added:
                raise ValueError("Road collapses onto a single node - draw a longer road")
            self.net = FastNetwork(ids, lat, lon, zone, eids, src, dst, length, cap, t0, cost, t0_ref=t0r)
            self.geom = geom
            return {"added_edges": added, "new_nodes": new_nodes, "junctions": len(cut) - new_nodes}

    def move_node(self, i: int, lat: float, lon: float):
        """Move a road node; incident edges get new geometry ends, length and (speed-preserving) travel time.
        Builds a new FastNetwork so the operation is a normal undo step."""
        with self.lock:
            net = self.net
            if not (0 <= i < net.n_nodes) or net.is_zone[i]:
                raise ValueError("only road nodes can be moved here (zones are moved by editing their shape)")
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("invalid position")
            la, lo = net.lat.copy(), net.lon.copy()
            la[i], lo[i] = lat, lon
            inc = np.flatnonzero((net.src == i) | (net.dst == i))
            length, t0r = net.length.copy(), net.t0_ref.copy()
            t0 = {m: a.copy() for m, a in net.t0.items()}
            cost = {m: a.copy() for m, a in net.cost.items()}
            geom = list(self.geom)
            for e in inc:
                g = geom[e]
                if g is not None:
                    g = g.copy()
                    if net.src[e] == i:
                        g[0] = (lon, lat)
                    if net.dst[e] == i:
                        g[-1] = (lon, lat)
                    geom[e] = g
                    pts = [(float(y), float(x)) for x, y in g]
                else:
                    pts = [(float(la[net.src[e]]), float(lo[net.src[e]])), (float(la[net.dst[e]]), float(lo[net.dst[e]]))]
                nl = max(osm_import.polyline_length_km(pts), 0.001)
                ratio = nl / max(net.length[e], 1e-6)
                length[e] = nl
                t0r[e] *= ratio
                for m in t0:
                    if t0[m][e] < CLOSED_T:
                        t0[m][e] *= ratio
                    cost[m][e] *= ratio
            self.net = FastNetwork(net.node_ids, la, lo, net.is_zone, net.edge_ids, net.src, net.dst, length, net.capacity,
                                   t0, cost, t0_ref=t0r)
            self.geom = geom
            return len(inc)

    def regen_od(self):
        if self.econ.get("enabled") and len(self.zones) >= 2:
            self.economic_demand()
        elif self.od_params and len(self.zones) >= 2:
            self.gravity(*self.od_params)
        elif self.od_params:
            self.od = {}

    def rename_zone(self, zid: str, name: str):
        for z in self.zones:
            if z["id"] == zid:
                z["name"] = name
                return
        raise KeyError(zid)

    def reshape_zone(self, zid: str, polygon):
        """New polygon for an existing zone: zone node moves to the new centroid and its connectors are rebuilt
        (node id, name and OD rows are kept)."""
        poly = [(float(a), float(b)) for a, b in polygon]
        if len(poly) < 3:
            raise ValueError("A zone needs at least 3 points")
        self.rebuild_connectors([zid], {zid: poly})

    def reconnect_all(self) -> dict:
        """Rebuild every zone's connectors with the current spreading rules."""
        with self.lock:
            before = int(((self.net.is_zone[self.net.src]) | (self.net.is_zone[self.net.dst])).sum())
            self.rebuild_connectors([z["id"] for z in self.zones])
            after = int(((self.net.is_zone[self.net.src]) | (self.net.is_zone[self.net.dst])).sum())
            return {"connector_edges_before": before, "connector_edges_after": after, "zones": len(self.zones)}

    def rebuild_connectors(self, zids, new_polys=None):
        """Drop and re-create the connector edges of the given zones (optionally with new polygons)."""
        with self.lock:
            net = self.net
            new_polys = new_polys or {}
            zmap = {z["id"]: z for z in self.zones}
            if any(z not in zmap for z in zids):
                raise KeyError(next(z for z in zids if z not in zmap))
            zi = {z: net.node_index[zmap[z]["node_id"]] for z in zids}
            ndrop = np.zeros(net.n_nodes, dtype=bool)
            ndrop[list(zi.values())] = True
            ekeep = ~(ndrop[net.src] | ndrop[net.dst])
            eremap = np.cumsum(ekeep) - 1
            lat, lon = net.lat.copy(), net.lon.copy()
            src, dst = list(net.src[ekeep]), list(net.dst[ekeep])
            eids = [e for e, kp in zip(net.edge_ids, ekeep) if kp]
            length, cap = list(net.length[ekeep]), list(net.capacity[ekeep])
            t0 = {m: list(a[ekeep]) for m, a in net.t0.items()}
            cost = {m: list(a[ekeep]) for m, a in net.cost.items()}
            t0r = list(net.t0_ref[ekeep])
            geom = [g for g, kp in zip(self.geom, ekeep) if kp]
            for zid in zids:
                z, i = zmap[zid], zi[zid]
                poly = new_polys.get(zid) or z["polygon"]
                c = osm_import.polygon_centroid(poly) if len(poly) >= 3 else (float(net.lat[i]), float(net.lon[i]))
                if zid in new_polys:
                    lat[i], lon[i] = c
                else:
                    c = (float(net.lat[i]), float(net.lon[i]))
                for r in self._targets(net, c, poly if len(poly) >= 3 else None, z.get("pop")):
                    d = max(osm_import.haversine_km(c[0], c[1], lat[r], lon[r]), 0.001)
                    tt = max(d / CONNECTOR_SPEED_KMH * 60, 0.05)
                    for a, b in ((i, int(r)), (int(r), i)):
                        src.append(a); dst.append(b); eids.append(f"c{zid}_{len(eids)}"); length.append(d)
                        cap.append(CONNECTOR_CAP)
                        for m in t0:
                            t0[m].append(tt); cost[m].append(d)
                        t0r.append(tt); geom.append(None)
                if zid in new_polys:
                    z["polygon"] = poly
            self.closed = {int(eremap[e]) for e in self.closed if ekeep[e]}
            self.net = FastNetwork(net.node_ids, lat, lon, net.is_zone, eids, src, dst, length, cap, t0, cost, t0_ref=t0r)
            self.geom = geom

    def delete_zones(self, zids) -> int:
        """Remove zone nodes + their connectors, reindexing nodes/edges."""
        with self.lock:
            net = self.net
            zmap = {z["id"]: z for z in self.zones}
            missing = [z for z in zids if z not in zmap]
            if missing:
                raise KeyError(missing[0])
            nodes = {zmap[z]["node_id"] for z in zids}
            ndrop = np.array([nid in nodes for nid in net.node_ids])
            edrop = ndrop[net.src] | ndrop[net.dst]
            nkeep, ekeep = ~ndrop, ~edrop
            remap = np.cumsum(nkeep) - 1
            eremap = np.cumsum(ekeep) - 1
            mid = next(iter(net.t0))
            new = FastNetwork([n for n, k in zip(net.node_ids, nkeep) if k], net.lat[nkeep], net.lon[nkeep], net.is_zone[nkeep],
                              [e for e, k in zip(net.edge_ids, ekeep) if k], remap[net.src[ekeep]], remap[net.dst[ekeep]],
                              net.length[ekeep], net.capacity[ekeep], {m: a[ekeep] for m, a in net.t0.items()},
                              {m: a[ekeep] for m, a in net.cost.items()}, t0_ref=net.t0_ref[ekeep])
            self.geom = [g for g, k in zip(self.geom, ekeep) if k]
            self.closed = {int(eremap[i]) for i in self.closed if ekeep[i]}
            self.net = new
            gone = set(zids)
            self.zones = [z for z in self.zones if z["id"] not in gone]
            self.od = {o: {d: v for d, v in ds.items() if d not in nodes} for o, ds in self.od.items() if o not in nodes}
            return len(gone)

    def road_node_counts(self) -> Dict[str, float]:
        """Number of road nodes inside each zone polygon (polygon-less zones count as 1)."""
        net = self.net
        road = ~net.is_zone
        out = {}
        for z in self.zones:
            poly = z["polygon"]
            if not poly:
                out[z["node_id"]] = 1.0
                continue
            la = [p[0] for p in poly]; lo = [p[1] for p in poly]
            cand = np.flatnonzero(road & (net.lat >= min(la)) & (net.lat <= max(la)) & (net.lon >= min(lo)) & (net.lon <= max(lo)))
            n = sum(1 for i in cand if osm_import.point_in_polygon(net.lat[i], net.lon[i], poly))
            out[z["node_id"]] = float(n)
        return out

    def zone_weights(self) -> Dict[str, float]:
        c = self.road_node_counts()
        return {k: max(v, 1.0) for k, v in c.items()}

    def zone_demand(self, attr_mix: float = 0.5):
        """(productions, attractions, info) per zone node id.
        Productions = census population when available (zones without a census count get nodes x the city average
        residents-per-node, flagged `pop_est`); attractions = a mix of population share and road-node share
        (road nodes are a stand-in for jobs/shops until real employment data is available).
        With no census data at all the old behaviour (road-node counts for both) is kept."""
        nodes = self.zone_weights()
        have = [z for z in self.zones if z.get("pop")]
        if not have:
            return nodes, dict(nodes), {z["node_id"]: {"pop": None, "pop_est": False} for z in self.zones}
        per_node = sum(z["pop"] for z in have) / max(sum(nodes[z["node_id"]] for z in have), 1.0)
        pop, est = {}, {}
        for z in self.zones:
            k = z["node_id"]
            est[k] = not z.get("pop")
            pop[k] = float(z["pop"]) if z.get("pop") else nodes[k] * per_node
        sp, sn = sum(pop.values()), sum(nodes.values())
        mix = min(max(attr_mix, 0.0), 1.0)
        attr = {k: (mix * pop[k] / sp + (1 - mix) * nodes[k] / sn) * sp for k in pop}
        return pop, attr, {k: {"pop": pop[k], "pop_est": est[k]} for k in pop}

    # ---- economic demand + modes ---------------------------------------------------------------
    def zone_pops(self) -> Dict[str, float]:
        prod, _, info = self.zone_demand()
        if not any(z.get("pop") for z in self.zones):
            raise ValueError("The economic model needs population: attach census data (or import a CSV with pop) first.")
        return {z["id"]: info[z["node_id"]]["pop"] for z in self.zones}

    def update_econ(self, patch: dict):
        for k, v in patch.items():
            if k == "purposes":
                for pk, pv in v.items():
                    self.econ["purposes"].setdefault(pk, {}).update(pv)
            elif (k in self.econ or k in economy.ECON_DEFAULTS) and k != "enabled":
                self.econ[k] = v

    def set_boost(self, ids, boost: float, numbered: bool = False) -> int:
        """Centrality factor on a zone's attraction (1 = none). `numbered` targets the poblacion barangays (Barangay 1, 2, ...)."""
        from server import census
        boost = float(boost)
        if not (0.0 <= boost <= 20.0):
            raise ValueError("Centrality factor must be between 0 and 20")
        n = 0
        with self.lock:
            for z in self.zones:
                hit = z["id"] in set(ids or []) or (numbered and census.zone_key(z["name"]).startswith("brgy") and census.zone_key(z["name"])[4:].isdigit())
                if hit:
                    z["boost"] = boost
                    n += 1
            if n:
                self.struct += 1; self.version += 1
        if n and self.econ.get("enabled") and len(self.zones) >= 2:
            self.economic_demand()
        return n

    def economic_demand(self) -> dict:
        """Allocate jobs/school seats/commercial attraction to zones and generate the peak-hour person-trip OD."""
        with self.lock:
            pops = self.zone_pops()
            rep = economy.allocate(self.zones, pops, self.econ)
            ni = self.net.node_index
            zs = self.zones
            coords = [(float(self.net.lat[ni[z["node_id"]]]), float(self.net.lon[ni[z["node_id"]]])) for z in zs]
            bst = [max(float(z.get("boost") or 1.0), 0.0) for z in zs]       # per-zone centrality factor on attraction
            attrs = {"jobs": [z["jobs"] * b for z, b in zip(zs, bst)], "students": [z["students"] * b for z, b in zip(zs, bst)],
                     "commerce": [z["commerce"] * b for z, b in zip(zs, bst)]}
            pop = [pops[z["id"]] for z in zs]
            od, by_purpose, summ = economy.generate_od([z["node_id"] for z in zs], coords, pop, attrs, self.econ)
            self.od, self.od_purpose = od, by_purpose
            self.econ["enabled"] = True
            self.od_params = None
            self.econ_summary = {**summ, **rep, "pop_total": float(sum(pop)), "boosted_zones": sum(1 for b in bst if abs(b - 1) > 1e-9)}
            self.flows = self.times = None
            self.mode_by_zone = {}
            self.version += 1
            return self.econ_summary

    def install_modes(self, cfg=None, b_cost=None, b_dur=None):
        with self.lock:
            self.mode_cfg = copy.deepcopy(cfg if cfg is not None else (self.mode_cfg or economy.DEFAULT_MODES))
            if b_cost is not None:
                self.b_cost = float(b_cost)
            if b_dur is not None:
                self.b_dur = float(b_dur)
            self.modes = economy.mode_objects(self.mode_cfg, self.b_cost, self.b_dur)
            self.prepare_modes()
            self.flows = self.times = None
            self.mode_by_zone = {}
            self.version += 1

    def prepare_modes(self):
        """(Re)build per-mode travel times and costs on the current network - call before every assignment, since
        edits, new roads and zone connectors change the car-equivalent times."""
        with self.lock:
            net = self.net
            if not self.mode_cfg:
                return
            t0, cost = economy.build_mode_arrays(net.length, net.t0_ref, self.closed, self.mode_cfg)
            net.t0, net.cost = t0, cost

    def attach_census(self) -> dict:
        from server import census
        with self.lock:
            rep = census.attach(self.zones)
            self.struct += 1
            self.version += 1
            return rep

    def gravity(self, total: float, beta: float, attr_mix: float = 0.5):
        with self.lock:
            self.od_params = (float(total), float(beta), float(attr_mix))
            self.econ["enabled"] = False                  # a plain gravity OD replaces the economic demand model
            zs = self.zones
            prod, attr, _ = self.zone_demand(attr_mix)
            ni = self.net.node_index
            coords = [(float(self.net.lat[ni[z["node_id"]]]), float(self.net.lon[ni[z["node_id"]]])) for z in zs]
            self.od = od_tools.gravity_od([z["node_id"] for z in zs], coords, total,
                                          productions=[prod[z["node_id"]] for z in zs],
                                          attractions=[attr[z["node_id"]] for z in zs], beta=beta,
                                          max_dest_per_origin=60 if len(zs) > 200 else None)

    # ---- geometry export -------------------------------------------------------
    def geometry_arrays(self):
        """(coords float64 (N,2) lon/lat, start_indices uint32 (E+1,))."""
        net = self.net
        parts, offs, pos = [], [0], 0
        for j in range(net.n_edges):
            g = self.geom[j] if j < len(self.geom) else None
            if g is None:
                g = np.array([[net.lon[net.src[j]], net.lat[net.src[j]]], [net.lon[net.dst[j]], net.lat[net.dst[j]]]])
            parts.append(g); pos += len(g); offs.append(pos)
        return (np.concatenate(parts) if parts else np.zeros((0, 2))), np.array(offs, dtype=np.uint32)

    def speed_kmh(self):
        net = self.net
        return net.length / np.maximum(net.t0_ref, 1e-6) * 60.0
