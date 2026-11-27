#!/usr/bin/env python3
"""Parse PSA 2020 CPH population by single-year age and barangay into age bands for Bacolod.

Input : data/psa/2020_popn_single_age_admin4.xlsx (HDX "Population by Single-Year Age, Sex and
        Admin4 (Barangay), Census 2020", CC BY; national file, only City of Bacolod rows are used)
Output: public/data/bacolod/barangay_demographics.json

Bands: 0-4, 5-14, 15-24, 25-59, 60+. Rows are matched to the boundaries file by normalised name.
Run with `uv run python -I scripts/parse_psa_age_sex.py` (the workbook is untrusted data).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_bir_zonal_values as bir  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_XLSX = REPO_ROOT / "data" / "psa" / "2020_popn_single_age_admin4.xlsx"
DEFAULT_BOUNDARIES = REPO_ROOT / "public" / "data" / "bacolod" / "boundaries.geojson"
DEFAULT_OUT = REPO_ROOT / "public" / "data" / "bacolod" / "barangay_demographics.json"

BANDS: list[tuple[str, int, int]] = [
    ("age_0_4", 0, 4),
    ("age_5_14", 5, 14),
    ("age_15_24", 15, 24),
    ("age_25_59", 25, 59),
    ("age_60_plus", 60, 200),
]
CITY_MARKER = "CITY OF BACOLOD"
PROVINCE = "NEGROS OCCIDENTAL"


def single_age_columns(header: Sequence[Any]) -> list[tuple[int, int]]:
    """(column index, age) for the both-sexes single-year columns ('Under 1_MF', '5_MF', '80 and Over_MF')."""
    out: list[tuple[int, int]] = []
    for i, h in enumerate(header):
        m = re.fullmatch(r"(Under 1|\d+|\d+ and Over)_MF", str(h).strip())
        if not m:
            continue
        label = m.group(1)
        age = 0 if label == "Under 1" else int(label.split()[0])
        out.append((i, age))
    return out


def band_counts(row: Sequence[Any], cols: list[tuple[int, int]]) -> dict[str, int]:
    counts = {name: 0 for name, _, _ in BANDS}
    for i, age in cols:
        v = row[i]
        if not isinstance(v, (int, float)):
            continue
        for name, lo, hi in BANDS:
            if lo <= age <= hi:
                counts[name] += int(v)
                break
    return counts


def parse_rows(rows: Iterable[Sequence[Any]]) -> dict[str, dict[str, Any]]:
    """Return {normalised barangay key: {name, total, bands...}} for City of Bacolod rows."""
    it = iter(rows)
    header = next(it)
    cols = single_age_columns(header)
    if not cols:
        raise SystemExit("No single-age columns found; the file layout changed")
    out: dict[str, dict[str, Any]] = {}
    for row in it:
        if len(row) < 7 or str(row[1]).strip().upper() != PROVINCE:
            continue
        if CITY_MARKER not in str(row[2]).upper():
            continue
        name = str(row[3]).strip()
        counts = band_counts(row, cols)
        out[bir.normalize_barangay(name)] = {"psa_name": name, "total": int(row[6]), **counts}
    return out


def build_payload(parsed: dict[str, dict[str, Any]], boundary_names: list[str]) -> dict[str, Any]:
    barangays: dict[str, Any] = {}
    missing: list[str] = []
    for name in boundary_names:
        rec = parsed.get(bir.normalize_barangay(name))
        if rec is None:
            missing.append(name)
            continue
        banded = sum(rec[b] for b, _, _ in BANDS)
        barangays[name] = {
            "population": rec["total"],
            **{b: rec[b] for b, _, _ in BANDS},
            "banded_total": banded,
        }
    wanted = {bir.normalize_barangay(n) for n in boundary_names}
    unmatched = sorted(r["psa_name"] for k, r in parsed.items() if k not in wanted)
    return {
        "source": "PSA 2020 Census of Population and Housing, via HDX (CC BY)",
        "bands": {b: [lo, hi if hi < 200 else None] for b, lo, hi in BANDS},
        "barangays": barangays,
        "unmatched_psa": unmatched,
        "missing": missing,
    }


def read_rows(path: Path) -> Iterable[Sequence[Any]]:
    import openpyxl  # imported lazily so unit tests do not need the workbook

    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb[wb.sheetnames[0]]
    return ws.iter_rows(values_only=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX)
    ap.add_argument("--boundaries", type=Path, default=DEFAULT_BOUNDARIES)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    parsed = parse_rows(read_rows(args.xlsx))
    payload = build_payload(parsed, bir.load_boundary_names(args.boundaries))
    args.out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    pop = sum(b["population"] for b in payload["barangays"].values())
    print(
        f"{len(payload['barangays'])} barangays matched (population {pop:,}); "
        f"missing {payload['missing']}; unmatched PSA {payload['unmatched_psa']}"
    )


if __name__ == "__main__":
    sys.exit(main())
