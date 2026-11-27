#!/usr/bin/env python3
"""Score every building POI with independent "votes" and flag the ones that look misplaced.

Overture/Foursquare pins are frequently wrong, so each POI gets votes from evidence we already
hold; nothing is deleted, the UI just marks low-trust pins:

  osm        +1  hand-placed OSM pin
  street     +1  pin lies within STREET_NEAR_M of an OSM road named in its address
             -1  an OSM road named in its address exists but every one is > STREET_FAR_M away
              0  no address, or no road name in it matches OSM (abstain)
  conflict   -1  a business-specific phone (<= PHONE_MAX_RECORDS records) appears on pins
                 more than CONFLICT_KM apart, so at least one copy is wrong

trust = "verified" (score >= 1), "unverified" (score <= -1), else "unrated".
Writes vote_score / trust / votes into public/data/bacolod/building_pois.json in place
(idempotent). Rerun after `npm run data:osm`:  uv run python scripts/score_poi_votes.py
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

REPO_ROOT = SCRIPTS.parent
OUT_DIR = PLACE.out_dir

STREET_NEAR_M = 150.0
STREET_FAR_M = 300.0
CONFLICT_KM = 0.5
PHONE_MAX_RECORDS = 3
BARANGAY_BORDER_TOL_M = 250.0
DEFAULT_BOUNDARIES = OUT_DIR / "boundaries.geojson"
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(PLACE.lat0))

_GENERIC = {*PLACE.name.upper().split(), "NEGROS", "OCCIDENTAL", "CITY", "PROPER", "OLD", "NEW", "NORTH", "SOUTH", "EAST", "WEST"}
_SUFFIX = re.compile(
    r"\b(STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|HIGHWAY|HWY|DRIVE|DR|EXTENSION|EXT|"
    r"NATIONAL|NAT|THE|OF|DEL|DE|GEN|GENERAL|SUBDIVISION|SUBD|VILLAGE)\b"
)
_ROAD_SUFFIX_WORDS = (
    r"(?:road|rd|street|st|avenue|ave|highway|hwy|boulevard|blvd|extension|ext|bridge|"
    r"access\s+(?:road|rd)|acces\s+(?:road|rd))"
)
_ROAD_AFTER_RE = re.compile(
    r"^\s*(?:[-/]\s*[a-z]+\s+|[a-z]+\s+)?" + _ROAD_SUFFIX_WORDS + r"\b",
    re.IGNORECASE,
)
_EXPLICIT_BRGY_BEFORE_RE = re.compile(r"\b(?:barangay|brgy\.?)\s*$", re.IGNORECASE)
_NUMBERED_BRGY_RE = re.compile(r"\b(?:barangay|brgy\.?)\s+(\d{1,2})\b", re.IGNORECASE)


def street_key(name: str) -> tuple[str, ...]:
    """'Bacolod Circumferential Road' -> ('CIRCUMFERENTIAL',); initials and generic words dropped."""
    s = re.sub(r"\(.*?\)", " ", name.upper())
    s = _SUFFIX.sub(" ", re.sub(r"[^A-Z0-9 ]", " ", s))
    return tuple(t for t in s.split() if (len(t) > 1 or t.isdigit()) and t not in _GENERIC)


def address_tokens(addr: str) -> set[str]:
    s = _SUFFIX.sub(" ", re.sub(r"[^A-Z0-9 ]", " ", addr.upper()))
    return set(s.split())


def streets_in_address(addr: str, road_keys: set[tuple[str, ...]]) -> list[tuple[str, ...]]:
    """Known OSM road keys whose every token appears in the address (single tokens need 5+ chars)."""
    toks = address_tokens(addr)
    return [k for k in road_keys if k and all(t in toks for t in k) and (len(k) > 1 or len(k[0]) >= 5)]


def normalize_phone(phone: str | None) -> str:
    first = re.split(r"[;,/]", str(phone or ""), maxsplit=1)[0]
    digits = re.sub(r"\D", "", first)
    if digits.startswith("63"):
        digits = digits[2:]
    digits = digits.lstrip("0")
    return "" if len(digits) < 7 or digits.startswith("2") else digits


def street_vote(distances_m: list[float]) -> int:
    """distances_m: distance from the pin to each OSM road matched by the address ([] = abstain)."""
    if not distances_m:
        return 0
    d = min(distances_m)
    if d <= STREET_NEAR_M:
        return 1
    return -1 if d > STREET_FAR_M else 0


def trust_label(score: int) -> str:
    return "verified" if score >= 1 else "unverified" if score <= -1 else "unrated"


def _km(a: list[float], b: list[float]) -> float:
    return math.hypot((a[0] - b[0]) * M_PER_DEG_LON, (a[1] - b[1]) * M_PER_DEG_LAT) / 1000.0


def load_barangay_geometries(boundaries_path: Path) -> tuple[dict[str, Any], dict[str, str]]:
    """Load level=='barangay' polygons projected to Bacolod planar meters and build name aliases."""
    if not boundaries_path.exists():
        return {}, {}

    import numpy as np
    import shapely
    from shapely.geometry import shape

    fc = json.loads(boundaries_path.read_text(encoding="utf-8"))
    brgy_geoms_m: dict[str, Any] = {}
    named_aliases: dict[str, str] = {}

    for feat in fc.get("features", []):
        props = feat.get("properties") or {}
        if props.get("level") != "barangay":
            continue
        name = str(props.get("name") or "").strip()
        if not name:
            continue
        geom_deg = shape(feat["geometry"])
        geom_m = shapely.transform(
            geom_deg, lambda c: np.column_stack((c[:, 0] * M_PER_DEG_LON, c[:, 1] * M_PER_DEG_LAT))
        )
        brgy_geoms_m[name] = geom_m
        low = name.lower()
        if re.match(r"^barangay\s+\d+$", low):
            continue
        named_aliases[low] = name
        if "-" in low:
            named_aliases[low.replace("-", " ")] = name
            if low == "singcang-airport":
                named_aliases["singcang"] = name

    return brgy_geoms_m, named_aliases


def extract_mentioned_barangays(
    addr: str,
    named_aliases: dict[str, str],
    valid_names: set[str] | None = None,
) -> list[str]:
    """Extract canonical Bacolod barangay names referenced in an address string."""
    if not addr:
        return []
    found: list[str] = []
    low = addr.lower()

    for m in _NUMBERED_BRGY_RE.finditer(low):
        canon = f"Barangay {int(m.group(1))}"
        if valid_names is not None and canon not in valid_names:
            continue
        if valid_names is None and not (1 <= int(m.group(1)) <= 41):
            continue
        if canon not in found:
            found.append(canon)

    for alias in sorted(named_aliases.keys(), key=len, reverse=True):
        canon = named_aliases[alias]
        for m in re.finditer(r"\b" + re.escape(alias) + r"\b", low):
            before = low[max(0, m.start() - 16) : m.start()]
            after = low[m.end() :]
            is_explicit = bool(_EXPLICIT_BRGY_BEFORE_RE.search(before))
            if not is_explicit and _ROAD_AFTER_RE.match(after):
                continue
            if canon not in found:
                found.append(canon)

    return found


def barangay_vote(
    pt_m: Any,
    addr: str | None,
    brgy_geoms_m: dict[str, Any],
    named_aliases: dict[str, str],
    border_tol_m: float = BARANGAY_BORDER_TOL_M,
) -> int:
    """Return +1 if pin lies within border_tol_m of a named barangay in its address, -2 if far away, else 0."""
    if not addr or not brgy_geoms_m:
        return 0
    mentioned = [
        name
        for name in extract_mentioned_barangays(addr, named_aliases, set(brgy_geoms_m))
        if name in brgy_geoms_m
    ]
    if not mentioned:
        return 0
    min_dist = min(float(pt_m.distance(brgy_geoms_m[name])) for name in mentioned)
    return 1 if min_dist <= border_tol_m else -2


def phone_conflicts(records: dict[str, Any]) -> set[tuple[str, int]]:
    """(building id, poi index) pairs whose phone sits on distant pins."""
    by_phone: dict[str, list[tuple[str, int, list[float]]]] = defaultdict(list)
    for bid, rec in records.items():
        for i, poi in enumerate(rec.get("pois", [])):
            ph = normalize_phone(poi.get("phone"))
            if ph:
                by_phone[ph].append((bid, i, rec["center"]))
    out: set[tuple[str, int]] = set()
    for group in by_phone.values():
        if len(group) < 2 or len(group) > PHONE_MAX_RECORDS:
            continue
        if max(_km(a[2], b[2]) for a in group for b in group) > CONFLICT_KM:
            out.update((bid, i) for bid, i, _ in group)
    return out


def score_poi(
    poi: dict[str, Any],
    street_distances: list[float],
    conflict: bool,
    barangay_v: int = 0,
) -> tuple[int, list[str]]:
    votes: list[str] = []
    score = 0
    if str(poi.get("source") or "osm") == "osm":
        score += 1
        votes.append("osm:+1")
    sv = street_vote(street_distances)
    if sv:
        score += sv
        votes.append(f"street:{sv:+d}")
    if barangay_v:
        score += barangay_v
        votes.append(f"barangay:{barangay_v:+d}")
    if conflict:
        score -= 1
        votes.append("conflict:-1")
    return score, votes


def score_flat_pois(
    pois: list[dict[str, Any]],
    roads: dict[tuple[str, ...], Any],
    brgy_geoms_m: dict[str, Any],
    named_aliases: dict[str, str],
) -> list[dict[str, Any]]:
    """Score a flat list of POI dicts in-place with vote_score, trust, votes, and barangay_vote."""
    from shapely.geometry import Point

    by_phone: dict[str, list[tuple[int, list[float]]]] = defaultdict(list)
    for idx, poi in enumerate(pois):
        ph = normalize_phone(poi.get("phone"))
        if ph and poi.get("lon") is not None and poi.get("lat") is not None:
            by_phone[ph].append((idx, [float(poi["lon"]), float(poi["lat"])]))

    conflict_indices: set[int] = set()
    for group in by_phone.values():
        if len(group) < 2 or len(group) > PHONE_MAX_RECORDS:
            continue
        if max(_km(a[1], b[1]) for a in group for b in group) > CONFLICT_KM:
            conflict_indices.update(idx for idx, _ in group)

    keys = set(roads)
    for idx, poi in enumerate(pois):
        pt_m = Point(float(poi["lon"]) * M_PER_DEG_LON, float(poi["lat"]) * M_PER_DEG_LAT)
        addr = poi.get("addr_street")
        dists: list[float] = []
        if addr and keys:
            dists = [pt_m.distance(roads[k]) for k in streets_in_address(str(addr), keys)]
        bv = barangay_vote(pt_m, str(addr) if addr else None, brgy_geoms_m, named_aliases)
        score, votes = score_poi(poi, dists, idx in conflict_indices, barangay_v=bv)
        poi["vote_score"] = score
        poi["trust"] = trust_label(score)
        poi["votes"] = votes
        poi["barangay_vote"] = bv

    return pois


def road_geometries(roads_pmtiles: Path) -> dict[tuple[str, ...], Any]:
    import numpy as np
    import shapely
    from shapely.ops import unary_union

    from estimate_building_zonal_values import load_named_roads

    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_votes_") as tmp:
        roads = load_named_roads(roads_pmtiles, Path(tmp))
    grouped: dict[tuple[str, ...], list[Any]] = defaultdict(list)
    for name, geom in roads:
        k = street_key(name)
        if k:
            grouped[k].append(
                shapely.transform(geom, lambda c: np.column_stack((c[:, 0] * M_PER_DEG_LON, c[:, 1] * M_PER_DEG_LAT)))
            )
    return {k: unary_union(v) for k, v in grouped.items()}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--pois", type=Path, default=OUT_DIR / "building_pois.json")
    ap.add_argument("--roads", type=Path, default=PLACE.pmtiles("roads"))
    ap.add_argument("--boundaries", type=Path, default=DEFAULT_BOUNDARIES)
    args = ap.parse_args()

    from shapely.geometry import Point

    records: dict[str, Any] = json.loads(args.pois.read_text(encoding="utf-8"))
    roads = road_geometries(args.roads)
    brgy_geoms_m, named_aliases = load_barangay_geometries(args.boundaries)
    keys = set(roads)
    conflicts = phone_conflicts(records)

    counts = {"verified": 0, "unverified": 0, "unrated": 0}
    for bid, rec in records.items():
        pt = Point(rec["center"][0] * M_PER_DEG_LON, rec["center"][1] * M_PER_DEG_LAT)
        for i, poi in enumerate(rec.get("pois", [])):
            dists: list[float] = []
            addr = poi.get("addr_street")
            if addr:
                dists = [pt.distance(roads[k]) for k in streets_in_address(str(addr), keys)]
            bv = barangay_vote(pt, str(addr) if addr else None, brgy_geoms_m, named_aliases)
            score, votes = score_poi(poi, dists, (bid, i) in conflicts, barangay_v=bv)
            poi["vote_score"] = score
            poi["trust"] = trust_label(score)
            poi["votes"] = votes
            counts[poi["trust"]] += 1
    args.pois.write_text(json.dumps(records, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("POI trust:", counts)


if __name__ == "__main__":
    main()
