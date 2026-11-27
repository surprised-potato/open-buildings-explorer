# File: engine/network.py
"""Array-based network used by the fast assignment engine.

Built from the object-based `NetworkGraph` (Tk app) or generated directly from arrays
(tests/benchmarks). Everything is index based: node i, edge e, mode slot m."""
from typing import Dict, List, Optional

import numpy as np
from scipy.sparse import csr_matrix

BIG = 1e9  # routing weight for unusable edges


class FastNetwork:
    def __init__(self, node_ids: List[str], lat, lon, is_zone, edge_ids: List[str],
                 src, dst, length, capacity, t0: Dict[str, np.ndarray], cost: Dict[str, np.ndarray],
                 t0_ref=None):
        self.node_ids = list(node_ids)
        self.node_index = {n: i for i, n in enumerate(self.node_ids)}
        self.lat = np.asarray(lat, dtype=float)
        self.lon = np.asarray(lon, dtype=float)
        self.is_zone = np.asarray(is_zone, dtype=bool)
        self.edge_ids = list(edge_ids)
        self.src = np.asarray(src, dtype=np.int64)
        self.dst = np.asarray(dst, dtype=np.int64)
        self.length = np.asarray(length, dtype=float)
        self.capacity = np.asarray(capacity, dtype=float)
        self.t0 = {m: np.asarray(a, dtype=float) for m, a in t0.items()}
        self.cost = {m: np.asarray(a, dtype=float) for m, a in cost.items()}
        if t0_ref is None:
            first = next(iter(self.t0.values())) if self.t0 else np.ones(len(self.src))
            t0_ref = np.where(np.isfinite(first), first, 1.0)
        self.t0_ref = np.asarray(t0_ref, dtype=float)
        self._build_structure()

    # -- structure -----------------------------------------------------------------
    @property
    def n_nodes(self) -> int:
        return len(self.node_ids)

    @property
    def n_edges(self) -> int:
        return len(self.src)

    def _build_structure(self):
        """Sorted CSR layout (one representative edge per (src,dst) pair)."""
        n = self.n_nodes
        key = self.src * n + self.dst
        order = np.lexsort((self.t0_ref, key))          # by key, then fastest first
        key_sorted = key[order]
        first = np.ones(len(order), dtype=bool)
        first[1:] = key_sorted[1:] != key_sorted[:-1]   # drop parallel duplicates
        self.csr_eid = order[first]                     # csr slot -> edge index
        self.csr_keys = key_sorted[first]               # sorted keys (searchsorted)
        csr_src = self.src[self.csr_eid]
        self.indices = self.dst[self.csr_eid].astype(np.int32)
        self.indptr = np.zeros(n + 1, dtype=np.int32)
        np.cumsum(np.bincount(csr_src, minlength=n), out=self.indptr[1:])
        self.n_duplicates = int(len(order) - len(self.csr_eid))

    def csr(self, weights: np.ndarray) -> csr_matrix:
        data = np.minimum(weights[self.csr_eid], BIG)
        data = np.maximum(data, 1e-9)
        return csr_matrix((data, self.indices, self.indptr), shape=(self.n_nodes, self.n_nodes))

    def edge_of(self, prev_nodes: np.ndarray, cur_nodes: np.ndarray) -> np.ndarray:
        """Vectorised (u, v) -> edge index for the representative edges."""
        slots = np.searchsorted(self.csr_keys, prev_nodes.astype(np.int64) * self.n_nodes + cur_nodes)
        return self.csr_eid[slots]

    def nearest_nodes(self, lat: float, lon: float, k: int = 1, road_only: bool = True):
        """Indices of the k nearest nodes (planar approx. in a local metric frame)."""
        tree, idx = self._tree(road_only)
        _, nn = tree.query([lat, lon * self._kx], k=min(k, len(idx)))
        return idx[np.atleast_1d(nn)]

    def _tree(self, road_only: bool):
        key = "_tree_road" if road_only else "_tree_all"
        if getattr(self, key, None) is None:
            from scipy.spatial import cKDTree
            idx = np.flatnonzero(~self.is_zone) if road_only else np.arange(self.n_nodes)
            kx = np.cos(np.radians(self.lat[idx].mean())) if len(idx) else 1.0
            self._kx = kx
            setattr(self, key, (cKDTree(np.column_stack([self.lat[idx], self.lon[idx] * kx])), idx))
        return getattr(self, key)

    # -- conversion ----------------------------------------------------------------
    @classmethod
    def from_network(cls, network, modes) -> "FastNetwork":
        """Build from a NetworkGraph + modes dict {mode_id: Mode}."""
        node_ids = list(network.nodes.keys())
        idx = {n: i for i, n in enumerate(node_ids)}
        nodes = [network.nodes[n] for n in node_ids]
        edges = [e for e in network.edges.values() if e.start_node_id in idx and e.end_node_id in idx]
        t0 = {m: np.empty(len(edges)) for m in modes}
        cost = {m: np.empty(len(edges)) for m in modes}
        for j, e in enumerate(edges):
            for m in modes:
                mv = e.modal_values.get(m, {})
                d = mv.get("duration")
                if d is None:
                    d = e.free_flow_time
                t0[m][j] = float("inf") if d is None else d
                c = mv.get("cost")
                cost[m][j] = e.distance if c is None else c
        return cls(node_ids, [n.lat for n in nodes], [n.lon for n in nodes], [n.is_zone for n in nodes],
                   [e.id for e in edges], [idx[e.start_node_id] for e in edges],
                   [idx[e.end_node_id] for e in edges], [e.distance for e in edges],
                   [e.capacity for e in edges], t0, cost,
                   t0_ref=[e.free_flow_time if e.free_flow_time is not None else
                           next((t0[m][j] for m in modes if np.isfinite(t0[m][j])), 1.0)
                           for j, e in enumerate(edges)])

    def write_flows(self, network, flows: Dict[str, np.ndarray]):
        """Store per-mode flows back on the Edge objects."""
        for j, eid in enumerate(self.edge_ids):
            e = network.edges.get(eid)
            if e is not None:
                e.flow = {m: float(a[j]) for m, a in flows.items()}
