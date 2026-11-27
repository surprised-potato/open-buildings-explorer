#!/usr/bin/env python3
"""Estimate a BIR zonal value (PHP/sqm) for every building footprint.

BIR publishes values per street/vicinity, not per parcel, so each building inherits a value by
the best available evidence (the `tier`):
  1  nearest named road (<= 75 m) matches a BIR street listed for the building's barangay
  2  that road name is listed in a different barangay (street crosses a boundary): median of those
  3  the barangay's "ALL OTHER STREETS/LOTS" row, else the barangay median for the land-use group
  4  city median for the land-use group (barangay absent from the BIR sheet)

Land-use group follows the building class: commercial/retail/office/hotel/mixed-use -> commercial,
industrial/warehouse -> industrial, everything else -> residential (falls back to residential if the
street has no row for the group). This is an estimate of a tax floor, not a market price or a
parcel-level value.

Output: public/data/bacolod/building_zonal.bin + building_zonal.json
Run: uv run python -I scripts/estimate_building_zonal_values.py   (after `npm run data:zonal`)
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import struct
import subprocess
import sys
import tempfile
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import parse_bir_zonal_values as bir  # noqa: E402

REPO_ROOT = SCRIPTS.parent
OUT_DIR = REPO_ROOT / "public" / "data" / "bacolod"
BUILDINGS_PMTILES = OUT_DIR / "bacolod_buildings.pmtiles"
ROADS_PMTILES = OUT_DIR / "bacolod_roads.pmtiles"
BOUNDARIES = OUT_DIR / "boundaries.geojson"

MAGIC = 0x4C565A42  # 'BZVL'
VERSION = 1
VALUE_UNIT = 5  # stored value = round(PHP / 5), u16 -> max PHP 327,675
NO_STREET = 0xFFFF
MAX_ROAD_M = 75.0
# Valuation assumptions used by the inspector (stored in building_zonal.json so they can be tuned
# without regenerating the binary). Zonal values price LAND only; improvements are separate.
VALUATION = {
    "note": (
        "BIR zonal values are per square metre of LAND. Lot area is inferred from the footprint "
        "(footprint / coverage); the structure is replacement cost = footprint x floors x cost per m2. "
        "Coverage ratios and non-residential costs are assumptions, not surveyed."
    ),
    "coverage": {"residential": 0.6, "commercial": 0.8, "industrial": 0.6},
    "costPerM2": {"residential": 10700, "commercial": 15000, "industrial": 8500},
    "costSource": (
        "Residential: PSA approved-building-permit average, about PHP 10.7k/m2 (2024; declared permit "
        "costs, typically below real cost). Commercial 1.4x and industrial 0.8x residential: assumed."
    ),
}
TIER_LABELS = [
    "",
    "Street match in barangay",
    "Street match in another barangay",
    "Barangay 'all other streets' / median",
    "City median",
]
COMMERCIAL_CLASSES = {"commercial", "retail", "supermarket", "hotel", "office", "mixed_use"}
INDUSTRIAL_CLASSES = {"industrial", "warehouse"}
CATCH_ALL = ("ALL OTHER", "AGRI")

_SUFFIX = re.compile(
    r"\b(STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|HIGHWAY|HWY|DRIVE|DR|EXTENSION|EXT|"
    r"NATIONAL|NAT|THE|OF|DEL|DE|GEN|GENERAL|SUBDIVISION|SUBD|VILLAGE)\b"
)


def normalize_street(name: str) -> str:
    """'A. Locsin St.' / 'LOCSIN STREET' -> 'LOCSIN'; ordinals kept ('17TH STREET' -> '17TH')."""
    s = re.sub(r"\(.*?\)", " ", name.upper())
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    s = _SUFFIX.sub(" ", s)
    tokens = [t for t in s.split() if len(t) > 1 or t.isdigit()]
    return " ".join(tokens)


def land_use_group(bclass: str) -> str:
    c = (bclass or "").lower()
    if c in COMMERCIAL_CLASSES:
        return "commercial"
    if c in INDUSTRIAL_CLASSES:
        return "industrial"
    return "residential"


def build_tables(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Index BIR entries: street values per (barangay, street) and group medians."""
    street_vals: dict[tuple[str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    name_vals: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    brgy_vals: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    catch_all: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    city: dict[str, list[float]] = defaultdict(list)
    for e in entries:
        b = bir.normalize_barangay(e["barangay"])
        g, v = e["group"], e["value"]
        city[g].append(v)
        brgy_vals[b][g].append(v)
        if e["street"].upper().startswith(CATCH_ALL):
            catch_all[b][g].append(v)
            continue
        key = normalize_street(e["street"])
        if not key:
            continue
        street_vals[(b, key)][g].append(v)
        name_vals[key][g].append(v)
    return {
        "street": street_vals,
        "name": name_vals,
        "brgy": brgy_vals,
        "catch_all": catch_all,
        "city": {g: statistics.median(v) for g, v in city.items()},
    }


def _pick(groups: dict[str, list[float]], group: str) -> float | None:
    vals = groups.get(group) or (groups.get("residential") if group != "residential" else None)
    return statistics.median(vals) if vals else None


def resolve_value(
    tables: dict[str, Any],
    barangay_key: str | None,
    road_names: list[str],
    group: str,
) -> tuple[float, int, str | None]:
    """Return (value PHP/sqm, tier, matched street label) for one building.

    `road_names` are the named roads within range, nearest first."""
    keys = [k for k in (normalize_street(n) for n in road_names) if k]
    if barangay_key:
        for raw, k in zip(road_names, keys):
            groups = tables["street"].get((barangay_key, k))
            v = _pick(groups, group) if groups else None
            if v is not None:
                return v, 1, raw
    for raw, k in zip(road_names, keys):
        groups = tables["name"].get(k)
        v = _pick(groups, group) if groups else None
        if v is not None:
            return v, 2, raw
    if barangay_key:
        for source in ("catch_all", "brgy"):
            groups = tables[source].get(barangay_key)
            v = _pick(groups, group) if groups else None
            if v is not None:
                return v, 3, None
    city = tables["city"]
    return city.get(group, city["residential"]), 4, None


def pack_ids(ids: list[str]) -> list[tuple[bytes, int]]:
    """Valid UUID ids -> (16 raw bytes, original index), sorted by bytes for binary search."""
    out: list[tuple[bytes, int]] = []
    for i, s in enumerate(ids):
        try:
            out.append((uuid.UUID(s).bytes, i))
        except ValueError:
            continue
    out.sort(key=lambda t: t[0])
    return out


def write_outputs(
    ids: list[str],
    values: list[float],
    tiers: list[int],
    street_idx: list[int],
    streets: list[str],
    out_bin: Path,
    out_json: Path,
    meta: dict[str, Any],
) -> None:
    order = pack_ids(ids)
    n = len(order)
    header = struct.pack("<4I", MAGIC, VERSION, n, len(streets))
    id_bytes = b"".join(b for b, _ in order)
    v = bytearray()
    for _, i in order:
        v += struct.pack("<H", min(0xFFFF, round(values[i] / VALUE_UNIT)))
    t = bytes(tiers[i] for _, i in order)
    t += b"\0" * (-len(t) % 4)
    s = b"".join(struct.pack("<H", street_idx[i]) for _, i in order)
    s += b"\0" * (-len(s) % 4)
    out_bin.write_bytes(header + id_bytes + bytes(v) + t + s)
    out_json.write_text(
        json.dumps({**meta, "streets": streets, "tierLabels": TIER_LABELS, "valueUnit": VALUE_UNIT}, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )


LOW_LYING_M = 3.0  # same threshold as compute_barangay_analytics.py


def floors_for(num_floors: Any, height: Any) -> int:
    """num_floors when set, else round(height / 3.2), else 1 (matches the inspector)."""
    try:
        if num_floors is not None and float(num_floors) > 0:
            return max(1, round(float(num_floors)))
        if height is not None and float(height) > 0:
            return max(1, round(float(height) / 3.2))
    except (TypeError, ValueError):
        pass
    return 1


def building_value(
    value_per_m2: float, group: str, footprint_m2: float, floors: int
) -> tuple[float, float]:
    """(land, structure) PHP using the VALUATION assumptions."""
    land = value_per_m2 * footprint_m2 / VALUATION["coverage"][group]
    structure = footprint_m2 * floors * VALUATION["costPerM2"][group]
    return land, structure


def aggregate_barangay_property(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Roll per-building estimates up by barangay name.

    Each row: {barangay, group, tier, footprint, land, structure, elev (m or None)}.
    """
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        b = out.setdefault(
            r["barangay"],
            {
                "buildings": 0, "footprintM2": 0.0, "land": 0.0, "structure": 0.0,
                "byGroup": {}, "tiers": [0, 0, 0, 0], "lowLying": 0, "lowLyingValue": 0.0,
                "withElev": 0,
                # buildings (and PHP value) by the lowest storm-surge advisory that reaches them: [none, SSA1..SSA4]
                "surge": [0, 0, 0, 0, 0], "surgeValue": [0.0] * 5,
            },
        )
        total = r["land"] + r["structure"]
        b["buildings"] += 1
        b["footprintM2"] += r["footprint"]
        b["land"] += r["land"]
        b["structure"] += r["structure"]
        g = b["byGroup"].setdefault(r["group"], {"buildings": 0, "total": 0.0})
        g["buildings"] += 1
        g["total"] += total
        b["tiers"][r["tier"] - 1] += 1
        lvl = int(r.get("surge", 0))
        b["surge"][lvl] += 1
        b["surgeValue"][lvl] += total
        if r["elev"] is not None:
            b["withElev"] += 1
            if r["elev"] < LOW_LYING_M:
                b["lowLying"] += 1
                b["lowLyingValue"] += total
    for b in out.values():
        for k in ("footprintM2", "land", "structure", "lowLyingValue"):
            b[k] = round(b[k])
        b["surgeValue"] = [round(v) for v in b["surgeValue"]]
        for g in b["byGroup"].values():
            g["total"] = round(g["total"])
    return out


HAZARD_MAGIC = 0x44485A42  # 'BZHD'
SURGE_KEYS = ["surge_ssa1", "surge_ssa2", "surge_ssa3", "surge_ssa4"]
LOW_LYING_BIT = 8


def pack_hazard_value(surge_level: int, elev: float | None) -> int:
    """u8: bits 0-2 lowest storm-surge advisory reaching the building (0 none, 1-4), bit 3 elevation < 3 m."""
    v = surge_level & 7
    if elev is not None and elev < LOW_LYING_M:
        v |= LOW_LYING_BIT
    return v


def write_hazard_bin(ids: list[str], values: list[int], out_bin: Path, out_json: Path, meta: dict[str, Any]) -> None:
    order = pack_ids(ids)
    header = struct.pack("<4I", HAZARD_MAGIC, 1, len(order), 1)
    out_bin.write_bytes(header + b"".join(b for b, _ in order) + bytes(values[i] for _, i in order))
    out_json.write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def load_surge_polygons(path: Path) -> list[Any]:
    """Prepared polygons for storm-surge advisories 1-4 (None where a level is missing)."""
    from shapely.geometry import shape
    from shapely.prepared import prep

    if not path.exists():
        return [None] * 4
    fc = json.loads(path.read_text(encoding="utf-8"))
    by_key: dict[str, Any] = {}
    for f in fc["features"]:
        by_key[f["properties"]["hazard"]] = prep(shape(f["geometry"]))
    return [by_key.get(k) for k in SURGE_KEYS]


def surge_level(geom: Any, polys: list[Any]) -> int:
    """Lowest advisory (1-4) whose area the footprint touches, else 0. Advisories are nested, so
    test the widest first to skip clearly dry buildings quickly."""
    widest = next((p for p in reversed(polys) if p is not None), None)
    if widest is None or not widest.intersects(geom):
        return 0
    for i, p in enumerate(polys, start=1):
        if p is not None and p.intersects(geom):
            return i
    return 0


# ---------------------------------------------------------------- geometry (needs shapely)


def _to_meters(geom: Any, lat0: float) -> Any:
    import numpy as np
    import shapely

    kx = 111_320.0 * math.cos(math.radians(lat0))
    return shapely.transform(geom, lambda c: np.column_stack((c[:, 0] * kx, c[:, 1] * 110_540.0)))


def load_named_roads(path: Path, tmp: Path) -> list[tuple[str, Any]]:
    out = tmp / "roads.geojsonl"
    subprocess.run(
        ["ogr2ogr", "-f", "GeoJSONSeq", "-oo", "ZOOM_LEVEL=16", "-where", "name IS NOT NULL", "-select", "name", str(out), str(path), "roads"],
        check=True,
    )
    from shapely.geometry import shape

    roads = []
    with out.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                f = json.loads(line)
                name = (f.get("properties") or {}).get("name")
                if name:
                    roads.append((str(name), shape(f["geometry"])))
    return roads


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--buildings", type=Path, default=BUILDINGS_PMTILES)
    ap.add_argument("--roads", type=Path, default=ROADS_PMTILES)
    ap.add_argument("--boundaries", type=Path, default=BOUNDARIES)
    ap.add_argument("--xls", type=Path, default=bir.DEFAULT_XLS)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    from shapely.geometry import shape
    from shapely.strtree import STRtree

    from enrich_osm_buildings import load_stitched_buildings

    entries = bir.parse_rows(bir.read_xls_rows(args.xls))
    tables = build_tables(entries)

    fc = json.loads(args.boundaries.read_text(encoding="utf-8"))
    display_names = {
        bir.normalize_barangay(f["properties"]["name"]): f["properties"]["name"]
        for f in fc["features"]
        if f["properties"].get("level") == "barangay"
    }
    bpolys = [
        (bir.normalize_barangay(f["properties"]["name"]), shape(f["geometry"]))
        for f in fc["features"]
        if f["properties"].get("level") == "barangay"
    ]
    btree = STRtree([p for _, p in bpolys])
    lat0 = 10.676

    with tempfile.TemporaryDirectory(prefix="bacolod_zonal_") as tmpdir:
        tmp = Path(tmpdir)
        ids, geoms_deg, geoms_m, props = load_stitched_buildings(args.buildings, tmp)
        roads = load_named_roads(args.roads, tmp)

    rtree = STRtree([_to_meters(g, lat0) for _, g in roads])
    road_geoms_m = [rtree.geometries[i] for i in range(len(roads))]
    road_names = [n for n, _ in roads]

    streets: list[str] = []
    street_ix: dict[str, int] = {}
    values: list[float] = []
    tiers: list[int] = []
    street_idx: list[int] = []
    tier_counts = [0] * 5

    from compute_barangay_analytics import load_dem_sampler

    dem = load_dem_sampler(args.out_dir / "dem" / "dem_manifest.json")
    prop_rows: list[dict[str, Any]] = []
    surge_polys = load_surge_polygons(args.out_dir / "hazards.geojson")
    hazard_vals: list[int] = []

    kept_ids: list[str] = []
    outside = 0
    for fid, gd, gm in zip(ids, geoms_deg, geoms_m):
        pt = gd.representative_point()
        hits = btree.query(pt, predicate="within")
        if not len(hits):
            outside += 1  # beyond Bacolod's barangays (tiles cover a wider bbox): no BIR value
            continue
        bkey = bpolys[int(hits[0])][0]
        kept_ids.append(fid)
        pt_m = _to_meters(pt, lat0)
        cand = rtree.query(pt_m.buffer(MAX_ROAD_M))
        ranked = sorted(
            ((pt_m.distance(road_geoms_m[int(i)]), int(i)) for i in cand),
            key=lambda t: t[0],
        )
        names: list[str] = []
        for d, i in ranked:
            if d <= MAX_ROAD_M and road_names[i] not in names:
                names.append(road_names[i])
        group = land_use_group(str((props.get(fid) or {}).get("bclass") or "unknown"))
        value, tier, street = resolve_value(tables, bkey, names, group)
        elev = dem(pt.x, pt.y)
        slevel = surge_level(gd, surge_polys)
        hazard_vals.append(pack_hazard_value(slevel, elev))
        pr = props.get(fid) or {}
        land, structure = building_value(
            value, group, float(gm.area), floors_for(pr.get("num_floors"), pr.get("effective_height") or pr.get("height"))
        )
        prop_rows.append({
            "barangay": display_names[bkey], "group": group, "tier": tier, "footprint": float(gm.area),
            "land": land, "structure": structure, "elev": elev, "surge": slevel,
        })
        values.append(value)
        tiers.append(tier)
        tier_counts[tier] += 1
        if street is None:
            street_idx.append(NO_STREET)
        else:
            if street not in street_ix:
                street_ix[street] = len(streets)
                streets.append(street)
            street_idx.append(street_ix[street])

    ids = kept_ids
    n = len(ids)
    meta = {
        "source": "Estimated from BIR RDO 77 DO 058-2023 street values",
        "effectivity": "2023-11-01",
        "unit": "PHP per square metre",
        "buildings": n,
        "outsideCity": outside,
        "tierCounts": tier_counts[1:],
        "maxRoadM": MAX_ROAD_M,
        "valuation": VALUATION,
        "note": "Estimate: building inherits its nearest matching street's BIR tax floor; not a parcel value or market price.",
    }
    write_outputs(ids, values, tiers, street_idx, streets, args.out_dir / "building_zonal.bin", args.out_dir / "building_zonal.json", meta)
    write_hazard_bin(
        ids, hazard_vals, args.out_dir / "building_hazard.bin", args.out_dir / "building_hazard.json",
        {
            "source": "Project NOAH storm surge advisories (ODbL) and Copernicus GLO-30 elevation",
            "valueBits": {"surge": "bits 0-2: lowest storm surge advisory reaching the building (1-4, 0 none)", "lowLying": "bit 3: elevation below 3 m"},
            "surgeLabels": ["Not reached", "Reached by surge 2-3 m", "Reached by surge 3-4 m", "Reached by surge 4-5 m", "Reached by surge over 5 m"],
            "lowLyingM": LOW_LYING_M,
            "note": "Modelled hazard, not a prediction. NOAH flood maps do not cover Bacolod City.",
        },
    )
    agg = aggregate_barangay_property(prop_rows)
    (args.out_dir / "barangay_property.json").write_text(
        json.dumps(
            {"valuation": VALUATION, "lowLyingM": LOW_LYING_M, "tierLabels": TIER_LABELS[1:], "surgeLabels": ["Not reached", "Surge 2-3 m", "Surge 3-4 m", "Surge 4-5 m", "Surge over 5 m"], "barangays": agg},
            separators=(",", ":"), ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"{n} buildings ({outside} outside the city skipped); tiers 1-4: {tier_counts[1:]}; median value {statistics.median(values):.0f}")


if __name__ == "__main__":
    main()
