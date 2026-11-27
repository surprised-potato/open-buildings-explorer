# File: engine/od.py
"""OD matrix helpers for many zones: gravity model + CSV import/export (sparse dict form)."""
import csv
import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

OD = Dict[str, Dict[str, float]]


def gravity_od(zone_ids: Sequence[str], coords: Sequence[Tuple[float, float]], total_trips: float,
               productions: Optional[Sequence[float]] = None, attractions: Optional[Sequence[float]] = None,
               beta: float = 1.0, min_km: float = 0.5, balance_iters: int = 20,
               max_dest_per_origin: Optional[int] = None) -> OD:
    """Doubly-constrained gravity model, T_ij ~ P_i A_j / d_ij^beta, scaled to total_trips.

    Weights default to 1 (equal size). Keeps memory sparse via max_dest_per_origin (top-N)."""
    n = len(zone_ids)
    if n < 2 or total_trips <= 0:
        return {}
    P = np.asarray(productions if productions is not None else np.ones(n), dtype=float)
    A = np.asarray(attractions if attractions is not None else P, dtype=float)
    lat = np.radians([c[0] for c in coords]); lon = np.radians([c[1] for c in coords])
    dphi = lat[:, None] - lat[None, :]
    dl = lon[:, None] - lon[None, :]
    h = np.sin(dphi / 2) ** 2 + np.cos(lat)[:, None] * np.cos(lat)[None, :] * np.sin(dl / 2) ** 2
    d = 2 * 6371.0088 * np.arcsin(np.sqrt(h))
    f = np.power(np.maximum(d, min_km), -beta)
    np.fill_diagonal(f, 0.0)
    if max_dest_per_origin and max_dest_per_origin < n - 1:
        keep = np.zeros_like(f, dtype=bool)
        top = np.argsort(-(f * A[None, :]), axis=1)[:, :max_dest_per_origin]
        np.put_along_axis(keep, top, True, axis=1)
        f = np.where(keep, f, 0.0)
    T = P[:, None] * A[None, :] * f
    if T.sum() <= 0:
        return {}
    T *= total_trips / T.sum()
    for _ in range(balance_iters):               # furness balancing to the marginals
        rs = T.sum(axis=1); T *= np.divide(P / P.sum() * total_trips, rs, out=np.ones_like(rs), where=rs > 0)[:, None]
        cs = T.sum(axis=0); T *= np.divide(A / A.sum() * total_trips, cs, out=np.ones_like(cs), where=cs > 0)[None, :]
    T *= total_trips / T.sum()
    od: OD = {}
    for i in range(n):
        row = {zone_ids[j]: float(T[i, j]) for j in np.flatnonzero(T[i] > 1e-9)}
        if row:
            od[zone_ids[i]] = row
    return od


def od_total(od: OD) -> float:
    return float(sum(sum(d.values()) for d in od.values()))


def write_od_csv(path: str, od: OD, names: Optional[Dict[str, str]] = None):
    names = names or {}
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["origin", "destination", "trips"])
        for o, dests in od.items():
            for d, t in dests.items():
                if t > 0:
                    w.writerow([names.get(o, o), names.get(d, d), f"{t:.4f}"])


def read_od_csv(path: str, name_to_id: Dict[str, str]) -> Tuple[OD, List[str]]:
    """Rows origin,destination,trips matched by zone name (or id). Returns (od, skipped_msgs)."""
    od: OD = {}
    skipped: List[str] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for ln, row in enumerate(csv.reader(f), start=1):
            if len(row) < 3 or (ln == 1 and not _is_num(row[2])):
                continue
            o, d = name_to_id.get(row[0].strip()), name_to_id.get(row[1].strip())
            if o is None or d is None or not _is_num(row[2]) or float(row[2]) < 0:
                skipped.append(f"line {ln}: {row}")
                continue
            if o != d and float(row[2]) > 0:
                od.setdefault(o, {})[d] = od.get(o, {}).get(d, 0.0) + float(row[2])
    return od, skipped


def _is_num(s) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False
