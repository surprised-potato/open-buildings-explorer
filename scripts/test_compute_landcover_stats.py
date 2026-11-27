import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compute_landcover_stats as lc  # noqa: E402


class Landcover(unittest.TestCase):
    def test_shares_ignore_nodata_and_sum_to_100(self) -> None:
        a = np.array([10, 10, 50, 0, 40, 10, 50, 50], dtype=np.uint8)
        s = lc.shares(a)
        self.assertEqual(s, {"tree_cover": 42.86, "cropland": 14.29, "built_up": 42.86})
        self.assertEqual(lc.shares(np.zeros(4, dtype=np.uint8)), {})

    def test_per_barangay_uses_cell_centres_inside_polygon(self) -> None:
        from shapely.geometry import box

        # 4x4 grid, cell 1 deg; left half tree cover (10), right half built-up (50)
        arr = np.array([[10, 10, 50, 50]] * 4, dtype=np.uint8)
        out = lc.per_barangay(arr, 0.0, 4.0, 1.0, [("W", box(0, 0, 2, 4)), ("E", box(2, 0, 4, 4)), ("Mid", box(1, 0, 3, 4))])
        self.assertEqual(out["W"], {"tree_cover": 100.0})
        self.assertEqual(out["E"], {"built_up": 100.0})
        self.assertEqual(out["Mid"], {"tree_cover": 50.0, "built_up": 50.0})

    def test_enrich_is_idempotent_and_touches_only_barangays(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / "a.json").write_text(json.dumps({"barangays": [{"name": "A", "x": 1}, {"name": "B"}]}))
            (p / "b.json").write_text(json.dumps({"features": [
                {"properties": {"name": "A", "level": "barangay"}},
                {"properties": {"name": "A", "level": "city"}},
            ]}))
            data = {"A": {"tree_cover": 30.0, "built_up": 60.0}}
            lc.enrich(p / "a.json", p / "b.json", data)
            lc.enrich(p / "a.json", p / "b.json", data)
            an = json.loads((p / "a.json").read_text())
            fc = json.loads((p / "b.json").read_text())
        self.assertEqual(an["barangays"][0]["tree_cover_pct"], 30.0)
        self.assertEqual(an["barangays"][0]["cropland_pct"], 0.0)
        self.assertNotIn("tree_cover_pct", an["barangays"][1])
        self.assertIn("tree_cover_pct", fc["features"][0]["properties"])
        self.assertNotIn("tree_cover_pct", fc["features"][1]["properties"])


if __name__ == "__main__":
    unittest.main()
