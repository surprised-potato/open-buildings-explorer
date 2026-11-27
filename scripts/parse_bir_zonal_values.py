#!/usr/bin/env python3
"""Parse the BIR RDO 77 (Bacolod City) zonal value workbook into per-barangay land-value stats.

Input : data/bir_zonal/RDO77_Bacolod_DO058-2023.xls (BIR, Department Order 058-2023, eff. 2023-11-01)
Output: public/data/bacolod/bir_zonal_values.json

The workbook holds one block per barangay: a "BARANGAY : <name>" header followed by rows of
(street, vicinity, classification, value PHP/sqm). Continuation rows leave the street blank.
Run with `uv run python -I scripts/parse_bir_zonal_values.py` (the input file is untrusted data).
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parents[1]
BIR = PLACE.setting("bir") or {}
DEFAULT_XLS = REPO_ROOT / BIR.get("xls", f"data/bir_zonal/{PLACE.slug}.xls")
DEFAULT_BOUNDARIES = PLACE.out_dir / "boundaries.geojson"
DEFAULT_OUT = PLACE.out_dir / "bir_zonal_values.json"
DEFAULT_ANALYTICS = PLACE.out_dir / "barangay_analytics.json"
SHEET_MARKER = BIR.get("sheet_marker", "")  # sheet name contains the Department Order number
TARGET_CITY = BIR.get("target_city", PLACE.display_name.lower())

# Classification code -> land-use group
GROUPS: dict[str, str] = {
    "RR": "residential",
    "RC": "residential",
    "CR": "commercial",
    "CC": "commercial",
    "I": "industrial",
    "GP": "general_purpose",
    "X": "institutional",
    "GL": "government",
    "APD": "other",
    "PS": "other",
    "CL": "other",
}


def classification_group(code: str) -> str | None:
    c = re.sub(r"[^A-Za-z0-9]", "", code).upper()
    if not c:
        return None
    if c in GROUPS:
        return GROUPS[c]
    if re.fullmatch(r"A\d{1,2}", c) or c == "A":
        return "agricultural"
    return None


def normalize_barangay(name: str) -> str:
    """'Barangay 1 Zone 1' -> 'barangay 1'; punctuation/case-insensitive key."""
    s = name.strip().lower()
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\bzone\s*\d+\b", " ", s)
    s = re.sub(r"\bbrgy\.?\b", "barangay", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    # 'barangay alangilan' -> 'alangilan' (numbered barangays keep the prefix: 'barangay 1')
    return re.sub(r"^barangay\s+(?=[a-z])", "", s)


def to_float(v: Any) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        t = v.replace(",", "").strip()
        try:
            return float(t)
        except ValueError:
            return None
    return None


def parse_rows(rows: Iterable[Sequence[Any]]) -> list[dict[str, Any]]:
    """Walk sheet rows and return flat entries for Bacolod City only.

    Each entry: {barangay, street, vicinity, code, group, value}.
    """
    entries: list[dict[str, Any]] = []
    city = ""
    barangay = ""
    street = ""
    vicinity = ""
    for row in rows:
        c0 = str(row[0]).strip() if len(row) > 0 and row[0] is not None else ""
        c1 = str(row[1]).strip() if len(row) > 1 and row[1] is not None else ""
        c2 = str(row[2]).strip() if len(row) > 2 and row[2] is not None else ""
        c3 = row[3] if len(row) > 3 else None

        up = c0.upper()
        if up.startswith("CITY/MUNICIPALITY"):
            city = c1.strip().lower()
            continue
        if up.startswith("BARANGAY"):
            barangay = c1.strip()
            street = ""
            vicinity = ""
            continue
        if up.startswith(("STREET NAME", "(LIST OF", "PROVINCE", "REVENUE")):
            continue

        value = to_float(c3)
        group = classification_group(c2)
        if value is None or group is None or value <= 0:
            continue
        if c0:
            street = c0
        if c1:
            vicinity = c1
        if city != TARGET_CITY or not barangay:
            continue
        entries.append(
            {
                "barangay": barangay,
                "street": street,
                "vicinity": vicinity,
                "code": re.sub(r"[^A-Za-z0-9]", "", c2).upper(),
                "group": group,
                "value": value,
            }
        )
    return entries


def summarize(values: list[float]) -> dict[str, float | int]:
    return {
        "n": len(values),
        "min": round(min(values)),
        "median": round(statistics.median(values)),
        "mean": round(statistics.fmean(values)),
        "max": round(max(values)),
    }


def aggregate(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per-barangay (normalized key) stats per land-use group, plus top commercial streets."""
    by_brgy: dict[str, list[dict[str, Any]]] = defaultdict(list)
    names: dict[str, set[str]] = defaultdict(set)
    for e in entries:
        key = normalize_barangay(e["barangay"])
        by_brgy[key].append(e)
        names[key].add(e["barangay"])

    out: dict[str, dict[str, Any]] = {}
    for key, items in by_brgy.items():
        groups: dict[str, list[float]] = defaultdict(list)
        for e in items:
            groups[e["group"]].append(e["value"])
        stats = {g: summarize(v) for g, v in groups.items()}
        commercial = sorted(
            (e for e in items if e["group"] == "commercial"),
            key=lambda e: -e["value"],
        )
        seen: set[tuple[str, str]] = set()
        top: list[dict[str, Any]] = []
        for e in commercial:
            k = (e["street"], e["vicinity"])
            if k in seen:
                continue
            seen.add(k)
            top.append({"street": e["street"], "vicinity": e["vicinity"], "value": round(e["value"])})
            if len(top) >= 5:
                break
        out[key] = {
            "bir_names": sorted(names[key]),
            "entries": len(items),
            "groups": stats,
            "top_commercial": top,
        }
    return out


def read_xls_rows(path: Path) -> list[list[Any]]:
    import xlrd  # imported lazily so unit tests do not need the dependency

    wb = xlrd.open_workbook(str(path))
    sheet = next(
        (wb.sheet_by_index(i) for i, n in enumerate(wb.sheet_names()) if SHEET_MARKER in n),
        None,
    )
    if sheet is None:
        raise SystemExit(f"No sheet containing '{SHEET_MARKER}' in {path}: {wb.sheet_names()}")
    return [[c.value for c in sheet.row(r)] for r in range(sheet.nrows)]


def load_boundary_names(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [
        f["properties"]["name"]
        for f in data["features"]
        if f["properties"].get("level") != "city"
    ]


def build_payload(
    rows: list[Sequence[Any]],
    boundary_names: list[str],
) -> dict[str, Any]:
    entries = parse_rows(rows)
    agg = aggregate(entries)
    wanted = {normalize_barangay(n): n for n in boundary_names}

    barangays: dict[str, Any] = {}
    for key, name in wanted.items():
        if key in agg:
            barangays[name] = agg[key]
    unmatched_bir = sorted(
        {n for key, rec in agg.items() if key not in wanted for n in rec["bir_names"]}
    )
    missing = sorted(name for key, name in wanted.items() if key not in agg)

    all_res = [e["value"] for e in entries if e["group"] == "residential"]
    all_com = [e["value"] for e in entries if e["group"] == "commercial"]
    return {
        "source": BIR.get("source", f"BIR zonal values, {PLACE.display_name}"),
        "source_url": BIR.get("source_url", "https://www.bir.gov.ph/zonal-values"),
        "department_order": BIR.get("department_order"),
        "revision": BIR.get("revision"),
        "effectivity": BIR.get("effectivity"),
        "unit": "PHP per square metre",
        "note": (
            "Zonal values are BIR tax floors per street/vicinity, not market prices. Group "
            "stats summarise street entries; they are not area-weighted."
        ),
        "city": {
            "entries": len(entries),
            "residential": summarize(all_res) if all_res else None,
            "commercial": summarize(all_com) if all_com else None,
        },
        "barangays": barangays,
        "unmatched_bir_barangays": unmatched_bir,
        "barangays_without_values": missing,
    }


def zonal_fields(rec: dict[str, Any]) -> dict[str, Any]:
    """Flat per-barangay fields shared by the analytics rows and boundaries properties."""
    res = rec["groups"].get("residential")
    com = rec["groups"].get("commercial")
    return {
        "zonal_res_median": res["median"] if res else None,
        "zonal_res_max": res["max"] if res else None,
        "zonal_com_median": com["median"] if com else None,
        "zonal_com_max": com["max"] if com else None,
        "zonal_entries": rec["entries"],
    }


def enrich_outputs(payload: dict[str, Any], analytics_path: Path, boundaries_path: Path) -> None:
    """Write zonal fields into barangay_analytics.json rows and boundaries.geojson properties
    (idempotent; rerun after compute_barangay_analytics.py, which rewrites those files)."""
    brgys = payload["barangays"]
    if analytics_path.exists():
        analytics = json.loads(analytics_path.read_text(encoding="utf-8"))
        for row in analytics.get("barangays", []):
            rec = brgys.get(row.get("name"))
            if not rec:
                continue
            row.update(zonal_fields(rec))
            row["zonal_top_commercial"] = rec["top_commercial"][:3]
        analytics["zonal"] = {
            "source": payload["source"],
            "department_order": payload["department_order"],
            "effectivity": payload["effectivity"],
            "unit": payload["unit"],
            "note": payload["note"],
            "city": payload["city"],
        }
        analytics_path.write_text(json.dumps(analytics, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    if boundaries_path.exists():
        fc = json.loads(boundaries_path.read_text(encoding="utf-8"))
        for feat in fc.get("features", []):
            props = feat.get("properties") or {}
            rec = brgys.get(str(props.get("name")))
            if props.get("level") == "barangay" and rec:
                props.update({k: v for k, v in zonal_fields(rec).items() if k != "zonal_entries"})
        boundaries_path.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--xls", type=Path, default=DEFAULT_XLS)
    ap.add_argument("--boundaries", type=Path, default=DEFAULT_BOUNDARIES)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--analytics", type=Path, default=DEFAULT_ANALYTICS)
    ap.add_argument("--no-enrich", action="store_true", help="only write bir_zonal_values.json")
    args = ap.parse_args()

    rows = read_xls_rows(args.xls)
    payload = build_payload(rows, load_boundary_names(args.boundaries))
    args.out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    if not args.no_enrich:
        enrich_outputs(payload, args.analytics, args.boundaries)
    print(
        f"Parsed {payload['city']['entries']} {PLACE.name} entries; "
        f"matched {len(payload['barangays'])} barangays; "
        f"unmatched BIR names: {payload['unmatched_bir_barangays']}; "
        f"barangays without values: {payload['barangays_without_values']}"
    )


if __name__ == "__main__":
    sys.exit(main())
