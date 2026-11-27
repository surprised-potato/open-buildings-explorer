#!/usr/bin/env python3
"""Unit tests for the BIR zonal value parser (uses synthetic rows, no .xls needed)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from parse_bir_zonal_values import (  # noqa: E402
    aggregate,
    build_payload,
    classification_group,
    normalize_barangay,
    parse_rows,
)

ROWS = [
    ["CITY/MUNICIPALITY                    :", "Bacolod City", "", ""],
    ["BARANGAY                                     :", "Barangay 1 Zone 1", "D.O. No.", "058-2023"],
    ["STREET NAME/ SUBDIVISION", "VICINITY", "CLASSIFICATION", "5TH REVISION ZV/SQ.M"],
    ["LACSON ST", "NORTH DR TO BRIDGE", "CR", 50000.0],
    ["AGUINALDO ST.", "NORTH DR TO 28TH ST", "RR", 10200.0],
    ["", "", "CR *", 16400.0],  # continuation row inherits street + vicinity
    ["BARANGAY                                     :", "Barangay Alijis", "", ""],
    ["SOME RD", "INTERIOR", "RR", 2000.0],
    ["", "", "A3", 150.0],
    ["BARANGAY                                     :", "Barangay Alijis (cont.)", "", ""],
    ["OTHER RD", "ALONG HIGHWAY", "CR", 4000.0],
    ["CITY/MUNICIPALITY                    :", "Silay City", "", ""],
    ["BARANGAY                                     :", "Barangay Alijis", "", ""],
    ["SILAY ST", "ANY", "RR", 999999.0],  # other city: must be ignored
]


class TestParseBirZonalValues(unittest.TestCase):
    def test_normalize_and_groups(self) -> None:
        self.assertEqual(normalize_barangay("Barangay 1 Zone 1"), "barangay 1")
        self.assertEqual(normalize_barangay("Barangay Alijis (cont.)"), "alijis")
        self.assertEqual(normalize_barangay("Singcang-Airport"), "singcang airport")
        self.assertEqual(classification_group("CR *"), "commercial")
        self.assertEqual(classification_group("A12"), "agricultural")
        self.assertIsNone(classification_group("???"))

    def test_parse_rows_filters_city_and_inherits_streets(self) -> None:
        entries = parse_rows(ROWS)
        self.assertEqual(len(entries), 6)
        self.assertTrue(all(e["value"] < 999999 for e in entries))
        cont = [e for e in entries if e["value"] == 16400.0][0]
        self.assertEqual(cont["street"], "AGUINALDO ST.")
        self.assertEqual(cont["vicinity"], "NORTH DR TO 28TH ST")

    def test_aggregate_and_payload_matching(self) -> None:
        agg = aggregate(parse_rows(ROWS))
        self.assertEqual(agg["alijis"]["entries"], 3)
        self.assertEqual(agg["barangay 1"]["groups"]["commercial"]["max"], 50000)
        self.assertEqual(agg["barangay 1"]["top_commercial"][0]["street"], "LACSON ST")

        payload = build_payload(ROWS, ["Barangay 1", "Alijis", "Banago"])
        self.assertEqual(sorted(payload["barangays"]), ["Alijis", "Barangay 1"])
        self.assertEqual(payload["barangays_without_values"], ["Banago"])
        self.assertEqual(payload["unmatched_bir_barangays"], [])
        self.assertEqual(payload["effectivity"], "2023-11-01")


if __name__ == "__main__":
    unittest.main()
