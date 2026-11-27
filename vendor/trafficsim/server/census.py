# File: server/census.py
"""Barangay census data (PSA 2020 CPH, Bacolod City) and name matching to zones."""
import csv
import os
import re
from typing import Dict, Optional

DATA = os.path.join(os.path.dirname(__file__), "..", "data", "psa_2020_bacolod.csv")
SOURCE = "PSA 2020 Census of Population and Housing (via HDX, CC BY)"


def norm(name: str) -> str:
    s = re.sub(r"\(.*?\)", " ", name.lower())
    s = re.sub(r"\bbarangay\b|\bbrgy\.?\b|\bbgy\.?\b|\bpob\.?\b|\bpoblacion\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


def load_bacolod(path: str = DATA) -> Dict[str, dict]:
    out = {}
    with open(path, "r", encoding="utf-8") as f:
        rows = csv.DictReader(l for l in f if not l.startswith("#"))
        for r in rows:
            out[zone_key(r["name"])] = {"psgc": r["psgc"], "name": r["name"], "pop": int(r["pop2020"]), "ur": r["urban_rural"]}
    return out


def zone_key(name: str) -> str:
    k = norm(name)
    return "brgy" + k if k.isdigit() else k            # "Barangay 8", "Brgy. 8", "8" all map to brgy8


def attach(zones, table: Optional[Dict[str, dict]] = None) -> dict:
    """Write psgc/pop/pop_year/pop_src onto zones whose names match the census table. Returns a match report."""
    table = table or load_bacolod()
    matched, unmatched, used = 0, [], set()
    for z in zones:
        rec = table.get(zone_key(z["name"]))
        if rec and rec["psgc"] not in used:
            z.update(psgc=rec["psgc"], pop=rec["pop"], pop_year=2020, pop_src=SOURCE, urban_rural=rec["ur"])
            used.add(rec["psgc"]); matched += 1
        else:
            for k in ("psgc", "pop", "pop_year", "pop_src", "urban_rural"):
                z.pop(k, None)
            unmatched.append(z["name"])
    missing = [r["name"] for r in table.values() if r["psgc"] not in used]
    return {"matched": matched, "zones_without_census": unmatched, "census_without_zone": missing,
            "matched_population": sum(r["pop"] for r in table.values() if r["psgc"] in used),
            "city_population": sum(r["pop"] for r in table.values())}
