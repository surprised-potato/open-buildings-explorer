"""Create or refresh regions/negros-occidental.json from the PSA 2020 barangay census file.

Adds every city and municipality of the province with its PSGC code, barangay count and
population. Hand-maintained settings on existing entries (bbox, BIR workbook, barangay names,
status, ...) are kept; only the census fields are refreshed.

Run: uv run python -I scripts/init_region_registry.py
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_XLSX = REPO_ROOT / "data" / "psa" / "2020_popn_single_age_admin4.xlsx"
DEFAULT_OUT = REPO_ROOT / "regions" / "negros-occidental.json"
PROVINCE = "NEGROS OCCIDENTAL"


def clean_name(psa_name: str) -> tuple[str, str]:
    """'CITY OF BACOLOD (Capital)' -> ('Bacolod', 'city'); 'HINOBA-AN (ASIA)' -> ('Hinoba-an', 'municipality')."""
    s = re.sub(r"\s*\(.*?\)\s*", " ", psa_name).strip()
    kind = "municipality"
    if s.upper().startswith("CITY OF "):
        kind = "city"
        s = s[8:]
    words = []
    for w in s.split():
        if re.fullmatch(r"[A-Z]\.", w):
            words.append(w)
        else:
            words.append(w.lower().capitalize())
    return " ".join(words), kind


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace(".", "")).strip("-")


def municipality_psgc(barangay_code: str) -> str:
    """PH0604502001 (barangay) -> PH0604502000 (its city or municipality)."""
    return barangay_code[:-3] + "000"


def summarise(rows: list[tuple[Any, ...]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        if len(row) < 7 or str(row[1]).strip().upper() != PROVINCE:
            continue
        psa_name = str(row[2]).strip()
        rec = out.setdefault(psa_name, {"psgc": municipality_psgc(str(row[4]).strip()), "barangays": 0, "pop": 0})
        rec["barangays"] += 1
        rec["pop"] += int(row[6] or 0)
    return out


def merge(existing: dict[str, Any], summary: dict[str, dict[str, Any]]) -> dict[str, Any]:
    by_psa = {p["psa_name"]: p for p in existing.get("places", [])}
    places = []
    for psa_name, rec in sorted(summary.items(), key=lambda kv: -kv[1]["pop"]):
        name, kind = clean_name(psa_name)
        entry = dict(by_psa.get(psa_name, {}))
        entry.setdefault("slug", slugify(name))
        entry.setdefault("name", name)
        entry.setdefault("display_name", f"{name} City" if kind == "city" else name)
        entry["psa_name"] = psa_name
        entry["psgc"] = rec["psgc"]
        entry["kind"] = kind
        entry.setdefault("status", "planned")
        entry["population_2020"] = rec["pop"]
        entry["barangay_count"] = rec["barangays"]
        places.append(entry)
    return {
        "region": existing.get("region", "negros-occidental"),
        "province": PROVINCE,
        "province_display": existing.get("province_display", "Negros Occidental"),
        "default_place": existing.get("default_place", "bacolod"),
        "census_source": "PSA 2020 Census of Population and Housing, via HDX (CC BY)",
        "places": places,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    import openpyxl

    wb = openpyxl.load_workbook(args.xlsx, read_only=True)
    rows = list(wb[wb.sheetnames[0]].iter_rows(values_only=True))[1:]
    existing = json.loads(args.out.read_text(encoding="utf-8")) if args.out.exists() else {}
    reg = merge(existing, summarise(rows))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(reg['places'])} places, {sum(p['barangay_count'] for p in reg['places'])} barangays -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
