"""Name keys for matching barangay and LGU names across PSA, Overture and OSM spellings."""
from __future__ import annotations

import re
import unicodedata


def barangay_key(name: str) -> str:
    """'Barangay Zone 1-A (Pob.)' -> 'zone 1 a'; 'Brgy. 8' -> 'barangay 8'; 'Sum-ag' -> 'sum ag'.

    Unlike parse_bir_zonal_values.normalize_barangay this keeps "zone" numbers, which tell barangays apart
    in towns such as Pulupandan; it is used to match census rows and boundary names.
    """
    s = unicodedata.normalize("NFKC", str(name or "")).strip().lower()  # 'Ⅷ' -> 'viii'
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\bpob\b\.?", " ", s)  # 'Barangay 1 Pob.' -> 'barangay 1' (the word 'poblacion' is kept)
    s = re.sub(r"\bbrgy\.?|\bbgy\.?", "barangay", s)
    s = s.replace("ñ", "n")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = roman_to_int(s)  # 'barangay viii' -> 'barangay 8' before the prefix rule below
    s = re.sub(r"^barangay\s+(?=[a-z])", "", s)  # 'barangay alangilan' -> 'alangilan'; 'barangay 8' stays
    return s


def roman_to_int(s: str) -> str:
    """'barangay iv' -> 'barangay 4' (some towns number barangays in roman numerals)."""
    numerals = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10,
                "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15, "xvi": 16, "xvii": 17, "xviii": 18}
    return re.sub(r"\b(barangay|zone|poblacion) ([ivx]+)\b", lambda m: f"{m.group(1)} {numerals.get(m.group(2), m.group(2))}", s)


def match_key(name: str) -> str:
    return roman_to_int(barangay_key(name))


def lgu_key(name: str) -> str:
    """'CITY OF BAGO' / 'Bago City' / 'Bago' -> 'bago'; 'Don Salvador Benedicto' -> 'salvador benedicto'."""
    s = re.sub(r"\(.*?\)", " ", str(name or "").lower())
    s = re.sub(r"\bcity of\b|\bcity\b|\bmunicipality of\b|\bdon\b", " ", s)
    s = s.replace("ñ", "n")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def best_match(key: str, candidates: set[str], cutoff: float = 0.85) -> str | None:
    """Exact key, else the single closest spelling among candidates (e.g. 'caradio an' -> 'cardio an')."""
    if key in candidates:
        return key
    import difflib

    close = difflib.get_close_matches(key, list(candidates), n=2, cutoff=cutoff)
    if len(close) == 1 or (len(close) == 2 and difflib.SequenceMatcher(None, key, close[0]).ratio()
                           > difflib.SequenceMatcher(None, key, close[1]).ratio() + 0.05):
        return close[0]
    return None
