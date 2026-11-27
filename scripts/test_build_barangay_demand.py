import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_barangay_demand as d  # noqa: E402

TARGETS = {"hbw": 0.48, "hbe": 0.35, "hbo": 0.17}


class Demand(unittest.TestCase):
    def test_matrix_rows_sum_to_one(self) -> None:
        for band, row in d.PURPOSE_MATRIX.items():
            self.assertAlmostEqual(sum(row.values()), 1.0, msg=band)
        self.assertEqual(set(d.PURPOSE_MATRIX), set(d.TRIP_RATES))

    def test_city_shares_match_targets_and_mixes_differ(self) -> None:
        demo = {
            "Students": {"population": 1000, "age_0_4": 50, "age_5_14": 400, "age_15_24": 300, "age_25_59": 200, "age_60_plus": 50},
            "Workers": {"population": 1000, "age_0_4": 50, "age_5_14": 100, "age_15_24": 150, "age_25_59": 600, "age_60_plus": 100},
            "Retirees": {"population": 1000, "age_0_4": 50, "age_5_14": 100, "age_15_24": 100, "age_25_59": 400, "age_60_plus": 350},
        }
        out = d.build_demand(demo, TARGETS)
        city = {p: sum(b["prod"][p] for b in out.values()) for p in d.PURPOSES}
        tot = sum(city.values())
        for p in d.PURPOSES:
            self.assertAlmostEqual(city[p] / tot, TARGETS[p], places=3)
        self.assertGreater(out["Students"]["mix"]["hbe"], out["Workers"]["mix"]["hbe"])
        self.assertGreater(out["Workers"]["mix"]["hbw"], out["Students"]["mix"]["hbw"])
        self.assertGreater(out["Retirees"]["mix"]["hbo"], out["Workers"]["mix"]["hbo"])
        for b in out.values():
            self.assertAlmostEqual(sum(b["mix"].values()), 1.0, places=3)


if __name__ == "__main__":
    unittest.main()
