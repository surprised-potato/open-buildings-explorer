#!/usr/bin/env python3
"""Trip production by purpose (home-work / home-school / home-other) for each barangay.

Inputs : public/data/bacolod/barangay_demographics.json (PSA 2020 age bands, parse_psa_age_sex.py)
         public/data/bacolod/mobility_zones.json (city purpose shares, for calibration)
Output : public/data/bacolod/barangay_demand.json

Method: trips/day per age band = residents x JICA Metro Cebu 2014 HIS trip rate for that band (Table
1.5.5), split to purposes with an assumed age-to-purpose matrix, then each purpose is scaled so the
city totals equal the model's purpose shares (48/35/17). Only the spatial spread changes.
The matrix and the band-averaged rates are assumptions; both are written into the output.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place, get_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = PLACE.out_dir

PURPOSES = ["hbw", "hbe", "hbo"]

# JICA Metro Cebu HIS 2014 trip rates (trips/person/day) by 5-year band, Table 1.5.5, averaged into the
# PSA bands. 5-14 = mean(2.72, 3.67); 15-24 = mean(3.99, 3.53); 25-59 = mean of seven bands;
# 60+ weighted 0.35/0.27/0.19/0.12/0.07 over 60-64..80+ (the age split inside 60+ is an assumption).
TRIP_RATES: dict[str, float] = {
    "age_0_4": 0.10,
    "age_5_14": 3.195,
    "age_15_24": 3.76,
    "age_25_59": 3.436,
    "age_60_plus": 1.375,
}

# Share of each band's trips by purpose. ASSUMPTION (the survey gives no purpose split by age).
PURPOSE_MATRIX: dict[str, dict[str, float]] = {
    "age_0_4": {"hbw": 0.0, "hbe": 0.0, "hbo": 1.0},
    "age_5_14": {"hbw": 0.0, "hbe": 0.9, "hbo": 0.1},
    "age_15_24": {"hbw": 0.25, "hbe": 0.6, "hbo": 0.15},
    "age_25_59": {"hbw": 0.6, "hbe": 0.05, "hbo": 0.35},
    "age_60_plus": {"hbw": 0.1, "hbe": 0.0, "hbo": 0.9},
}


def raw_production(bands: dict[str, float]) -> dict[str, float]:
    out = {p: 0.0 for p in PURPOSES}
    for band, rate in TRIP_RATES.items():
        trips = float(bands.get(band, 0.0)) * rate
        for p in PURPOSES:
            out[p] += trips * PURPOSE_MATRIX[band][p]
    return out


def build_demand(
    demographics: dict[str, dict[str, Any]], targets: dict[str, float]
) -> dict[str, dict[str, Any]]:
    """Per barangay production and mix, scaled so city purpose shares equal `targets`."""
    raw = {name: raw_production(rec) for name, rec in demographics.items()}
    city_raw = {p: sum(r[p] for r in raw.values()) for p in PURPOSES}
    city_total = sum(city_raw.values())
    tsum = sum(targets[p] for p in PURPOSES)
    scale = {
        p: (targets[p] / tsum) * city_total / city_raw[p] if city_raw[p] > 0 else 0.0
        for p in PURPOSES
    }
    out: dict[str, dict[str, Any]] = {}
    for name, r in raw.items():
        prod = {p: r[p] * scale[p] for p in PURPOSES}
        tot = sum(prod.values())
        out[name] = {
            "population": demographics[name].get("population"),
            "prod": {p: round(prod[p], 1) for p in PURPOSES},
            "mix": {p: round(prod[p] / tot, 4) if tot > 0 else 0.0 for p in PURPOSES},
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--demographics", type=Path, default=OUT_DIR / "barangay_demographics.json")
    ap.add_argument("--zones", type=Path, default=OUT_DIR / "mobility_zones.json")
    ap.add_argument("--out", type=Path, default=OUT_DIR / "barangay_demand.json")
    args = ap.parse_args()

    demo = json.loads(args.demographics.read_text(encoding="utf-8"))["barangays"]
    if args.zones.exists():
        purposes = json.loads(args.zones.read_text(encoding="utf-8"))["purposes"]
    else:
        # New places have no mobility_zones.json yet (it is written later); the purpose shares are the same
        # model-wide calibration, so take them from the reference (Bacolod) state.
        ref = PLACE.trafficsim_state or get_place("bacolod").trafficsim_state
        purposes = json.loads((ref / "state.json").read_text(encoding="utf-8"))["econ"]["purposes"]
    targets = {p: float(purposes[p]["share"]) for p in PURPOSES}
    barangays = build_demand(demo, targets)
    payload = {
        "meta": {
            "source": "PSA 2020 age bands x JICA Metro Cebu 2014 HIS trip rates; age-to-purpose matrix assumed",
            "tripRates": TRIP_RATES,
            "purposeMatrix": PURPOSE_MATRIX,
            "cityShares": targets,
        },
        "barangays": barangays,
    }
    args.out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    hbe = sorted(((b["mix"]["hbe"], n) for n, b in barangays.items()))
    print(f"{len(barangays)} barangays; HBE share {hbe[0][0]:.2f} ({hbe[0][1]}) to {hbe[-1][0]:.2f} ({hbe[-1][1]})")


if __name__ == "__main__":
    sys.exit(main())
