# File: engine/assign.py
"""Fast multimodal user-equilibrium assignment (Frank-Wolfe, BPR, logit mode split).

Per iteration: one scipy Dijkstra per (origin, mode) -- not per OD pair -- then path
tracing is vectorised over all destinations of an origin. Mode split is recomputed
each iteration from congested skims."""
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from scipy.sparse.csgraph import dijkstra

from .network import FastNetwork, BIG

ZONE_TRANSIT_PENALTY = 1e5   # minutes; keeps routes from cutting through other zones' centroids
MAX_MULT = 1e6


class AssignCancelled(Exception):
    pass


@dataclass
class AssignResult:
    flows: Dict[str, np.ndarray]
    iterations: int = 0
    gap: float = float("inf")
    converged: bool = False
    unreachable_pairs: int = 0
    unreachable_trips: float = 0.0
    mode_trips: Dict[str, float] = field(default_factory=dict)
    total_trips: float = 0.0
    times: Dict[str, np.ndarray] = field(default_factory=dict)  # final congested time per mode
    mode_by_origin: Dict[int, np.ndarray] = field(default_factory=dict)  # origin node idx -> person trips per mode (order of `mode_ids`)
    mode_ids: List[str] = field(default_factory=list)

    @property
    def total_flow(self) -> np.ndarray:
        return sum(self.flows.values())


def od_to_arrays(net: FastNetwork, od: Dict[str, Dict[str, float]]) -> List[Tuple[int, np.ndarray, np.ndarray]]:
    """{o_id: {d_id: trips}} -> [(o_idx, dest_idx[], trips[]), ...] (positive trips, o != d)."""
    out = []
    for o_id, dests in od.items():
        o = net.node_index.get(o_id)
        if o is None:
            continue
        d_idx, trips = [], []
        for d_id, t in dests.items():
            d = net.node_index.get(d_id)
            if d is None or d == o or t is None or t <= 0:
                continue
            d_idx.append(d)
            trips.append(float(t))
        if d_idx:
            out.append((o, np.asarray(d_idx, dtype=np.int64), np.asarray(trips)))
    return out


def bpr_multiplier(flow: np.ndarray, capacity: np.ndarray, alpha: float, beta: float) -> np.ndarray:
    cap = np.where(capacity > 0, capacity, 1e-6)
    with np.errstate(over="ignore", invalid="ignore"):
        m = 1.0 + alpha * np.power(flow / cap, beta)
    return np.minimum(np.nan_to_num(m, nan=MAX_MULT, posinf=MAX_MULT), MAX_MULT)


def _trace(net: FastNetwork, pred: np.ndarray, origin: int, dests: np.ndarray):
    """Walk predecessor pointers for all dests at once; returns [(positions, edge_idx), ...]."""
    pos = np.arange(len(dests))
    cur = dests.copy()
    hops = []
    while pos.size:
        prv = pred[cur].astype(np.int64)
        hops.append((pos, net.edge_of(prv, cur)))
        keep = prv != origin
        pos, cur = pos[keep], prv[keep]
    return hops


def _all_or_nothing(net: FastNetwork, modes: Dict[str, object], times: Dict[str, np.ndarray],
                    od: List[Tuple[int, np.ndarray, np.ndarray]], first_pass: bool,
                    check_cancel: Callable[[], None], chunk: int = 16):
    mode_ids = list(modes.keys())
    nm = len(mode_ids)
    y = {m: np.zeros(net.n_edges) for m in mode_ids}
    mode_trips = {m: 0.0 for m in mode_ids}
    by_origin: Dict[int, np.ndarray] = {}
    vfac = {m: float(getattr(modes[m], 'veh_factor', 1.0)) for m in mode_ids}
    unreach_pairs, unreach_trips = 0, 0.0
    zone_pen = np.where(net.is_zone[net.src], ZONE_TRANSIT_PENALTY, 0.0)
    mats = {m: net.csr(times[m] + zone_pen) for m in mode_ids}
    asc = np.array([modes[m].asc for m in mode_ids])
    b_cost = np.array([modes[m].beta_cost for m in mode_ids])
    b_dur = np.array([modes[m].beta_duration for m in mode_ids])

    buf_e = {m: [] for m in mode_ids}
    buf_w = {m: [] for m in mode_ids}
    buffered = 0

    def flush():
        nonlocal buffered
        for m in mode_ids:
            if buf_e[m]:
                y[m] += np.bincount(np.concatenate(buf_e[m]), weights=np.concatenate(buf_w[m]),
                                    minlength=net.n_edges)
                buf_e[m].clear(); buf_w[m].clear()
        buffered = 0

    for c0 in range(0, len(od), chunk):
        check_cancel()
        batch = od[c0:c0 + chunk]
        origins = [b[0] for b in batch]
        res = {m: dijkstra(mats[m], directed=True, indices=origins, return_predecessors=True)
               for m in mode_ids}
        for row, (o, dests, trips) in enumerate(batch):
            nd = len(dests)
            util = np.full((nm, nd), -np.inf)
            traces = []
            pen = ZONE_TRANSIT_PENALTY if net.is_zone[o] else 0.0
            for mi, m in enumerate(mode_ids):
                dist = res[m][0][row][dests]
                pred = res[m][1][row]
                ok = (dist - pen) < ZONE_TRANSIT_PENALTY / 2   # also rejects routes that cut through a zone
                hops = []
                if ok.any():
                    sel = np.flatnonzero(ok)
                    hops = _trace(net, pred, o, dests[sel])
                    cost = np.zeros(len(sel))
                    for pos, eid in hops:
                        cost[pos] += net.cost[m][eid]
                    util[mi, sel] = asc[mi] + b_cost[mi] * cost + b_dur[mi] * (dist[sel] - pen)
                    traces.append((sel, hops))
                else:
                    traces.append((np.empty(0, dtype=np.int64), []))
            # logit split per destination
            mx = util.max(axis=0)
            reach = np.isfinite(mx)
            if first_pass and not reach.all():
                unreach_pairs += int((~reach).sum())
                unreach_trips += float(trips[~reach].sum())
            ex = np.exp(util - np.where(reach, mx, 0.0))
            ex[:, ~reach] = 0.0
            denom = ex.sum(axis=0)
            prob = np.divide(ex, denom, out=np.zeros_like(ex), where=denom > 0)
            demand = prob * trips
            by_origin[o] = by_origin.get(o, 0) + demand.sum(axis=1)
            for mi, m in enumerate(mode_ids):
                mode_trips[m] += float(demand[mi].sum())
                sel, hops = traces[mi]
                if not hops:
                    continue
                w_full = demand[mi][sel]
                for pos, eid in hops:
                    buf_e[m].append(eid)
                    buf_w[m].append(w_full[pos] * vfac[m])
                    buffered += len(eid)
            if buffered > 4_000_000:
                flush()
    flush()
    return y, mode_trips, unreach_pairs, unreach_trips, by_origin


def assign(net: FastNetwork, modes: Dict[str, object], od: Dict[str, Dict[str, float]],
           bpr_alpha: float = 0.15, bpr_beta: float = 4.0, max_iterations: int = 30,
           gap_tolerance: float = 0.01,
           progress: Optional[Callable[[int, int, float], None]] = None,
           cancel: Optional[Callable[[], bool]] = None,
           log: Optional[Callable[[str], None]] = None) -> AssignResult:
    """Frank-Wolfe user equilibrium. `modes` = {mode_id: Mode(asc, beta_cost, beta_duration)}.

    Congestion uses total flow over all modes: t_m = t0_m * (1 + a (v/c)^b). The line search
    and gap use the reference free-flow time `net.t0_ref`."""
    def check_cancel():
        if cancel and cancel():
            raise AssignCancelled()

    mode_ids = list(modes.keys())
    od_arr = od_to_arrays(net, od)
    result = AssignResult(flows={m: np.zeros(net.n_edges) for m in mode_ids}, mode_ids=mode_ids)
    congests = {m: bool(getattr(modes[m], 'congests', True)) for m in mode_ids}
    result.total_trips = float(sum(t.sum() for _, _, t in od_arr))
    if not od_arr or not mode_ids:
        result.converged = True
        return result

    v = {m: np.zeros(net.n_edges) for m in mode_ids}
    gap = float("inf")
    for k in range(1, max_iterations + 1):
        check_cancel()
        vt = sum(v.values())
        mult = bpr_multiplier(vt, net.capacity, bpr_alpha, bpr_beta)
        times = {m: (net.t0[m] * mult if congests[m] else net.t0[m]) for m in mode_ids}
        y, mode_trips, up, ut, by_origin = _all_or_nothing(net, modes, times, od_arr, k == 1, check_cancel)
        yt = sum(y.values())
        if k == 1:
            result.unreachable_pairs, result.unreachable_trips = up, ut
            lam = 1.0
        else:
            tv = net.t0_ref * mult
            denom = float((tv * vt).sum())
            gap = float((tv * (vt - yt)).sum()) / denom if denom > 0 else 0.0
            # bisection on d/dlam of the Beckmann objective along v + lam (y - v)
            d = yt - vt
            lo, hi = 0.0, 1.0
            for _ in range(14):
                mid = (lo + hi) / 2
                f = float((net.t0_ref * bpr_multiplier(vt + mid * d, net.capacity, bpr_alpha, bpr_beta) * d).sum())
                if f > 0:
                    hi = mid
                else:
                    lo = mid
            lam = (lo + hi) / 2
        for m in mode_ids:
            v[m] += lam * (y[m] - v[m])
        # report the step-weighted average of the all-or-nothing mode splits (like the flows themselves)
        if k == 1:
            avg_modes, avg_orig = dict(mode_trips), {o: a.copy() for o, a in by_origin.items()}
        else:
            for m in mode_ids:
                avg_modes[m] += lam * (mode_trips[m] - avg_modes[m])
            for o in set(avg_orig) | set(by_origin):
                a0, a1 = avg_orig.get(o, 0), by_origin.get(o, 0)
                avg_orig[o] = a0 + lam * (a1 - a0)
        result.mode_trips, result.mode_by_origin = avg_modes, avg_orig
        result.iterations = k
        result.gap = gap
        if log:
            log(f"iteration {k}: gap={gap:.5f} step={lam:.3f}")
        if progress:
            progress(k, max_iterations, gap)
        if k > 1 and gap < gap_tolerance:
            result.converged = True
            break
    result.flows = v
    vt = sum(v.values())
    mult = bpr_multiplier(vt, net.capacity, bpr_alpha, bpr_beta)
    result.times = {m: (net.t0[m] * mult if congests[m] else net.t0[m]) for m in mode_ids}
    return result
