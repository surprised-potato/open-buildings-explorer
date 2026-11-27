"""Estimate residents per building by spreading each barangay's census population over its buildings.

Method (dasymetric): residents_b = population(barangay) x home_weight_b / sum(home_weight in barangay).
home_weight is the simulation's own per-building home weight (export_trafficsim_network.py): residential
floor area in full, mixed use about half, unclassified a little, scaled by the WorldPop 100 m density grid.
Buildings are placed in barangays by the current boundary polygons (so Bacolod's Bata fix applies).
Barangay totals match PSA 2020 exactly; the split inside a barangay is an estimate. Age shares are the
barangay's (the census has no finer level).

Inputs : mobility_buildings.bin (weights, positions, ids), boundaries.geojson, barangay_demographics.json,
         building_hazard.bin (storm surge per building, for exposure totals)
Outputs: building_population.bin   sorted 16-byte building ids, residents u16 (x10), barangay index u16
         building_population.json  barangay names, age shares, totals, residents reached by storm surge
         population fields merged into barangay_analytics.json and boundaries.geojson
           (population, pop_density_per_km2, children_pct (0-14), seniors_pct (60+))
Run: uv run python -I scripts/estimate_building_population.py [--place slug]
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()
OUT_DIR = PLACE.out_dir
MAGIC_BBLD = 0x444C4242
MAGIC_BPOP = 0x504F5042  # 'BPOP'
HAZARD_MAGIC = 0x44485A42
RESIDENT_SCALE = 10  # stored value = round(residents x 10); u16 -> max 6553.5 residents
NO_BARANGAY = 0xFFFF
BANDS = ("age_0_4", "age_5_14", "age_15_24", "age_25_59", "age_60_plus")


def read_mobility_buildings(path: Path) -> dict[str, Any]:
    """Positions, home weights and ids from mobility_buildings.bin (layout in export_trafficsim_network.py)."""
    buf = path.read_bytes()
    head = np.frombuffer(buf, dtype="<u4", count=8)
    if int(head[0]) != MAGIC_BBLD:
        raise SystemExit("Bad mobility_buildings.bin magic")
    n, n_zones, n_nodes, has_ids = int(head[2]), int(head[3]), int(head[4]), int(head[6])
    o = 32

    def take(dtype: str, count: int, item: int) -> np.ndarray:
        nonlocal o
        arr = np.frombuffer(buf, dtype=dtype, count=count, offset=o)
        o += count * item
        o += (4 - o % 4) % 4
        return arr

    take("<u4", n_zones + 1, 4)
    lon = take("<f4", n, 4)
    lat = take("<f4", n, 4)
    take("<f4", n, 4)  # area
    take("<u2", n, 2)  # node
    take("u1", n, 1)  # class
    w_home = take("<u2", n, 2).astype(np.float64) / 64.0
    for _ in range(3):
        take("<u2", n, 2)
    take("<u2", 3 * n_zones * n_nodes, 2)
    if not has_ids:
        raise SystemExit("mobility_buildings.bin has no building ids; rerun the mobility stage")
    ids = np.frombuffer(buf, dtype="u1", count=16 * n, offset=o).reshape(n, 16)
    return {"n": n, "lon": lon, "lat": lat, "w_home": w_home, "ids": ids}


def read_surge(path: Path) -> dict[bytes, int]:
    if not path.exists():
        return {}
    buf = path.read_bytes()
    magic, _, n, _ = struct.unpack_from("<4I", buf, 0)
    if magic != HAZARD_MAGIC:
        return {}
    ids = buf[16:16 + 16 * n]
    vals = buf[16 + 16 * n:16 + 17 * n]
    return {ids[16 * i:16 * i + 16]: vals[i] & 7 for i in range(n) if vals[i] & 7}


def fallback_buildings(targets: list[int], geoms: list[Any], known: set[bytes]) -> dict[str, Any]:
    """Buildings inside the target barangays from the place's building tiles, weighted like the simulation's
    home weight (residential floor area 1, mixed use 0.5, unclassified 0.15, others 0.02)."""
    import tempfile
    import uuid

    from shapely.strtree import STRtree

    from enrich_osm_buildings import load_stitched_buildings

    factor = {"residential": 1.0, "house": 1.0, "apartments": 1.0, "detached": 1.0, "mixed_use": 0.5,
              "unknown": 0.15, "": 0.15}
    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_pop_") as tmp:
        bids, geoms_deg, _, props = load_stitched_buildings(PLACE.pmtiles("buildings"), Path(tmp))
    tree = STRtree([geoms[t] for t in targets])
    out_ids, out_b, out_w = [], [], []
    for fid, g in zip(bids, geoms_deg):
        hit = tree.query(g.representative_point(), predicate="within")
        if not len(hit):
            continue
        try:
            raw = uuid.UUID(str(fid)).bytes
        except ValueError:
            continue
        if raw in known:
            continue
        pr = props.get(fid) or {}
        cls = str(pr.get("bclass") or "").lower()
        floors = max(1.0, min(10.0, float(pr.get("num_floors") or 1)))
        out_ids.append(np.frombuffer(raw, dtype="u1"))
        out_b.append(targets[int(hit[0])])
        out_w.append(float(pr.get("area_m2") or 50.0) * floors * factor.get(cls, 0.02))
    n = len(out_ids)
    return {"n": n, "ids": np.vstack(out_ids) if n else np.zeros((0, 16), dtype="u1"),
            "brgy": np.array(out_b, dtype=np.int64), "w": np.array(out_w, dtype=np.float64)}


def distribute(brgy_of: np.ndarray, weights: np.ndarray, pops: list[float]) -> np.ndarray:
    """Residents per building: each barangay's population split in proportion to weight (equal split when
    a barangay has buildings but no home weight at all)."""
    res = np.zeros(len(weights))
    for b, pop in enumerate(pops):
        idx = np.flatnonzero(brgy_of == b)
        if not len(idx) or pop <= 0:
            continue
        w = weights[idx]
        total = w.sum()
        res[idx] = pop * (w / total if total > 0 else np.full(len(idx), 1.0 / len(idx)))
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_place_argument(ap)
    args = ap.parse_args()
    del args
    from shapely import points
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    mb = read_mobility_buildings(OUT_DIR / "mobility_buildings.bin")
    fc = json.loads((OUT_DIR / "boundaries.geojson").read_text(encoding="utf-8"))
    brgys = [f for f in fc["features"] if f["properties"].get("level") == "barangay"]
    names = [f["properties"]["name"] for f in brgys]
    geoms = [shape(f["geometry"]) for f in brgys]
    demo = json.loads((OUT_DIR / "barangay_demographics.json").read_text(encoding="utf-8"))["barangays"]

    tree = STRtree(geoms)
    pts = points(mb["lon"].astype(float), mb["lat"].astype(float))
    pairs = tree.query(pts, predicate="within")
    brgy_of = np.full(mb["n"], -1, dtype=np.int64)
    brgy_of[pairs[0]] = pairs[1]
    pops = [float(demo.get(n, {}).get("population", 0)) for n in names]
    weights = mb["w_home"]
    empty = [b for b, p in enumerate(pops) if p > 0 and not np.any(brgy_of == b)]
    if empty:
        # Barangays whose outline holds none of the simulation's buildings (outline changed after the
        # network was built, or outside its catchment): use their buildings from the tiles instead.
        extra = fallback_buildings(empty, geoms, set(bytes(r) for r in mb["ids"]))
        if extra["n"]:
            brgy_of = np.concatenate([brgy_of, extra["brgy"]])
            weights = np.concatenate([weights, extra["w"]])
            mb = {**mb, "n": mb["n"] + extra["n"], "ids": np.vstack([mb["ids"], extra["ids"]])}
        print(f"Fallback for {len(empty)} barangay(s) with no simulation buildings: {extra['n']} buildings from tiles")
    residents = distribute(brgy_of, weights, pops)

    # Pack sorted by id (binary search in the app).
    order = sorted(range(mb["n"]), key=lambda i: mb["ids"][i].tobytes())
    stored = np.minimum(np.round(residents * RESIDENT_SCALE), 65535).astype("<u2")
    bidx = np.where(brgy_of >= 0, brgy_of, NO_BARANGAY).astype("<u2")
    with (OUT_DIR / "building_population.bin").open("wb") as fh:
        fh.write(struct.pack("<4I", MAGIC_BPOP, 1, mb["n"], RESIDENT_SCALE))
        fh.write(b"".join(mb["ids"][i].tobytes() for i in order))
        fh.write(stored[order].tobytes())
        fh.write(bidx[order].tobytes())

    surge = read_surge(OUT_DIR / "building_hazard.bin")
    area_km2 = {f["properties"]["name"]: float(f["properties"].get("area_km2") or 0) for f in brgys}
    per: dict[str, Any] = {}
    for b, name in enumerate(names):
        rec = demo.get(name)
        idx = np.flatnonzero(brgy_of == b)
        surge_by = [0.0] * 5
        for i in idx:
            lvl = surge.get(mb["ids"][i].tobytes(), 0)
            surge_by[lvl] += residents[i]
        pop = float(rec["population"]) if rec else 0.0
        shares = {k: round(rec[k] / max(1, rec["banded_total"]), 4) for k in BANDS} if rec else {}
        per[name] = {
            "population": int(round(pop)),
            "buildings": int(len(idx)),
            "buildings_with_residents": int((residents[idx] >= 0.05).sum()),
            "age_shares": shares,
            "surge_residents": [round(v) for v in surge_by],
        }
    unplaced = float(sum(p for b, p in enumerate(pops) if not np.any(brgy_of == b)))
    meta = {
        "source": "PSA 2020 census (barangay totals and age bands) spread over buildings by the simulation's home weights",
        "method": "residents = barangay population x building home weight / barangay total home weight",
        "note": "Estimate. Totals match the census per barangay; individual buildings are modelled, not counted.",
        "residentScale": RESIDENT_SCALE,
        "barangays": names,
        "ageBands": list(BANDS),
        "surgeLabels": ["Not reached", "Surge 2-3 m", "Surge 3-4 m", "Surge 4-5 m", "Surge over 5 m"],
        "perBarangay": per,
        "population": int(round(sum(pops))),
        "placed": int(round(residents.sum())),
        "unplacedPopulation": int(round(unplaced)),
    }
    (OUT_DIR / "building_population.json").write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    # Barangay fields for choropleths and reports (merged in place, like the land-cover stage).
    fields: dict[str, dict[str, Any]] = {}
    for name in names:
        rec = demo.get(name)
        if not rec:
            continue
        tot = max(1, rec["banded_total"])
        km2 = area_km2.get(name) or 0
        fields[name] = {
            "population": int(rec["population"]),
            "pop_density_per_km2": round(rec["population"] / km2, 1) if km2 > 0 else None,
            "children_pct": round(100 * (rec["age_0_4"] + rec["age_5_14"]) / tot, 1),
            "seniors_pct": round(100 * rec["age_60_plus"] / tot, 1),
        }
    for f in fc["features"]:
        if f["properties"].get("name") in fields and f["properties"].get("level") == "barangay":
            f["properties"].update(fields[f["properties"]["name"]])
    (OUT_DIR / "boundaries.geojson").write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    ap_path = OUT_DIR / "barangay_analytics.json"
    if ap_path.exists():
        an = json.loads(ap_path.read_text(encoding="utf-8"))
        for row in an.get("barangays", []):
            if row.get("name") in fields:
                row.update(fields[row["name"]])
        ap_path.write_text(json.dumps(an, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    placed_share = 100 * meta["placed"] / max(1, meta["population"])
    print(f"{mb['n']:,} buildings; {meta['placed']:,} of {meta['population']:,} residents placed ({placed_share:.1f}%); "
          f"{sum(int((residents >= 0.05).sum()) for _ in [0]):,} buildings with residents")
    return 0


if __name__ == "__main__":
    sys.exit(main())
