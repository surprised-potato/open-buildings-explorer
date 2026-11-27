#!/usr/bin/env python3
"""Name every mobility-network edge after the OSM street it follows.

Input : public/data/bacolod/mobility_network.bin, bacolod_roads.pmtiles
Output: public/data/bacolod/mobility_edge_streets.json  {names: [...], edge: [u16 per edge, 65535 = unnamed]}

Each edge is sampled at 1/4, 1/2 and 3/4 of its polyline; the most common nearest named road within
MAX_DIST_M wins. Rerun after `npm run data:mobility` (the edge order changes with the network).
Run with `uv run python -I scripts/export_edge_streets.py` (data files are untrusted input).
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Sequence

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "public" / "data" / "bacolod"
MAGIC_BMOB = 0x424D4F42
NO_NAME = 0xFFFF
MAX_DIST_M = 25.0
LAT0 = 10.676
M_PER_DEG_LAT = 111_320.0


def read_edges(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (geom_offs[nEdges+1], coords[nPts, 2] lon/lat) from mobility_network.bin."""
    raw = path.read_bytes()
    magic, _ver, n_nodes, n_edges, n_pts, _zones, _prof, _r = struct.unpack_from("<8I", raw, 0)
    if magic != MAGIC_BMOB:
        raise SystemExit(f"Bad magic in {path}")
    o = 32 + 3 * n_nodes * 4
    pad = (n_edges % 2) * 2
    o += (n_edges * 2 + pad) * 2  # edge_src + edge_dst (each padded to 4 bytes)
    o += 7 * n_edges * 4  # length, capacity, then 5 per-profile free-flow times
    offs = np.frombuffer(raw, dtype="<u4", count=n_edges + 1, offset=o)
    o += (n_edges + 1) * 4
    coords = np.frombuffer(raw, dtype="<f4", count=2 * n_pts, offset=o).reshape(-1, 2)
    return offs.astype(np.int64), coords.astype(np.float64)


def sample_points(pts: np.ndarray) -> list[tuple[float, float]]:
    """Points at 1/4, 1/2, 3/4 of a polyline's length (lon, lat)."""
    if len(pts) == 1:
        return [(float(pts[0, 0]), float(pts[0, 1]))]
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    out = []
    for f in (0.25, 0.5, 0.75):
        t = total * f
        i = int(min(len(seg) - 1, max(0, np.searchsorted(cum, t, side="right") - 1)))
        u = 0.0 if seg[i] == 0 else (t - cum[i]) / seg[i]
        out.append((float(pts[i, 0] + u * (pts[i + 1, 0] - pts[i, 0])), float(pts[i, 1] + u * (pts[i + 1, 1] - pts[i, 1]))))
    return out


def majority_name(votes: Sequence[str | None]) -> str | None:
    named = [v for v in votes if v]
    if not named:
        return None
    return Counter(named).most_common(1)[0][0]


def to_m(lon: float, lat: float) -> tuple[float, float]:
    return lon * M_PER_DEG_LAT * math.cos(math.radians(LAT0)), lat * M_PER_DEG_LAT


def load_named_roads(path: Path, tmp: Path) -> list[tuple[str, Any]]:
    out = tmp / "roads.geojsonl"
    subprocess.run(
        ["ogr2ogr", "-f", "GeoJSONSeq", "-oo", "ZOOM_LEVEL=16", "-where", "name IS NOT NULL", "-select", "name", str(out), str(path), "roads"],
        check=True,
    )
    from shapely.geometry import shape
    import shapely

    kx = M_PER_DEG_LAT * math.cos(math.radians(LAT0))

    roads: list[tuple[str, Any]] = []
    with out.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                f = json.loads(line)
                name = (f.get("properties") or {}).get("name")
                if name:
                    roads.append((str(name), shapely.transform(shape(f["geometry"]), lambda a: np.column_stack([a[:, 0] * kx, a[:, 1] * M_PER_DEG_LAT]))))
    return roads


def name_edges(offs: np.ndarray, coords: np.ndarray, roads: list[tuple[str, Any]]) -> tuple[list[str], list[int]]:
    from shapely.geometry import Point
    from shapely.strtree import STRtree

    tree = STRtree([g for _, g in roads])
    names: list[str] = []
    index: dict[str, int] = {}
    out: list[int] = []
    for e in range(len(offs) - 1):
        pts = coords[offs[e] : offs[e + 1]]
        votes: list[str | None] = []
        if len(pts):
            for lon, lat in sample_points(pts):
                p = Point(*to_m(lon, lat))
                hit = tree.query_nearest(p, max_distance=MAX_DIST_M, all_matches=False)
                votes.append(roads[int(hit[0])][0] if len(hit) else None)
        name = majority_name(votes)
        if name is None:
            out.append(NO_NAME)
        else:
            if name not in index:
                index[name] = len(names)
                names.append(name)
            out.append(index[name])
    return names, out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--network", type=Path, default=OUT_DIR / "mobility_network.bin")
    ap.add_argument("--roads", type=Path, default=OUT_DIR / "bacolod_roads.pmtiles")
    ap.add_argument("--out", type=Path, default=OUT_DIR / "mobility_edge_streets.json")
    args = ap.parse_args()

    offs, coords = read_edges(args.network)
    with tempfile.TemporaryDirectory(prefix="bacolod_edges_") as d:
        roads = load_named_roads(args.roads, Path(d))
    names, edge = name_edges(offs, coords, roads)
    args.out.write_text(json.dumps({"names": names, "edge": edge}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    unnamed = sum(1 for v in edge if v == NO_NAME)
    print(f"{len(edge)} edges, {len(names)} street names, {unnamed} unnamed ({100 * unnamed / max(1, len(edge)):.1f}%)")


if __name__ == "__main__":
    sys.exit(main())
