import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_psa_age_sex as p  # noqa: E402

HEADER = ["Region", "Province", "Mun", "Bgy", "c", "o", "Total_MF", "Under 1_MF", "4_MF", "5_MF", "14_MF", "15_MF", "59_MF", "60_MF", "80 and Over_MF", "5_M"]


class ParsePsa(unittest.TestCase):
    def test_columns_only_both_sexes(self) -> None:
        cols = p.single_age_columns(HEADER)
        self.assertEqual([a for _, a in cols], [0, 4, 5, 14, 15, 59, 60, 80])

    def test_bands_and_filtering(self) -> None:
        rows = [
            HEADER,
            ["R6", "NEGROS OCCIDENTAL", "CITY OF BACOLOD (Capital)", "Barangay 1", "x", "y", 80, 1, 2, 3, 4, 5, 6, 7, 8, 99],
            ["R6", "NEGROS OCCIDENTAL", "SILAY CITY", "Other", "x", "y", 5, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            ["R10", "LANAO DEL NORTE", "BACOLOD", "Elsewhere", "x", "y", 5, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        ]
        out = p.parse_rows(rows)
        self.assertEqual(list(out), ["barangay 1"])
        r = out["barangay 1"]
        self.assertEqual((r["age_0_4"], r["age_5_14"], r["age_15_24"], r["age_25_59"], r["age_60_plus"]), (3, 7, 5, 6, 15))

    def test_payload_flags_missing_and_unmatched(self) -> None:
        parsed = {"barangay 1": {"psa_name": "Barangay 1", "total": 10, "age_0_4": 1, "age_5_14": 2, "age_15_24": 3, "age_25_59": 3, "age_60_plus": 1},
                  "ghost": {"psa_name": "Ghost", "total": 1, "age_0_4": 1, "age_5_14": 0, "age_15_24": 0, "age_25_59": 0, "age_60_plus": 0}}
        out = p.build_payload(parsed, ["Barangay 1", "Taculing"])
        self.assertEqual(out["missing"], ["Taculing"])
        self.assertEqual(out["unmatched_psa"], ["Ghost"])
        self.assertEqual(out["barangays"]["Barangay 1"]["banded_total"], 10)


if __name__ == "__main__":
    unittest.main()
