import unittest

from shapely.geometry import box, mapping

from apply_boundary_overrides import apply_overrides, km2_per_deg2, merge_gap_into, unassigned_pieces


def feat(name, level, g):
    return {"type": "Feature", "geometry": mapping(g), "properties": {"name": name, "level": level}}


def city():
    return {"features": [
        feat("City", "city", box(0, 0, 0.07, 0.03)),
        feat("Bata", "barangay", box(0, 0, 0.03, 0.03)),
        feat("Other", "barangay", box(0.05, 0, 0.07, 0.03)),
    ]}


class BoundaryOverrideTests(unittest.TestCase):
    def test_gap_touching_target_is_merged_and_idempotent(self):
        fc = city()
        self.assertIsNotNone(merge_gap_into(fc, "Bata", 1.0, 20.0))
        bata = next(f for f in fc["features"] if f["properties"]["name"] == "Bata")
        self.assertGreater(bata["properties"]["bbox"][2], 0.049)
        self.assertTrue(all(p.area * km2_per_deg2(10.7) < 0.01 for p in unassigned_pieces(fc)))
        self.assertIsNone(merge_gap_into(fc, "Bata", 1.0, 20.0))

    def test_rules_file_drives_the_merge_and_size_limits_hold(self):
        fc = city()
        self.assertEqual(apply_overrides(fc, {"assign_unassigned": [{"to": "Bata", "min_km2": 50, "max_km2": 60}]}, 10.7), [])
        done = apply_overrides(fc, {"assign_unassigned": [{"to": "Bata"}]}, 10.7)
        self.assertEqual(done[0]["to"], "Bata")

    def test_unknown_barangay_fails_loudly(self):
        with self.assertRaises(SystemExit):
            merge_gap_into(city(), "Nowhere", 1.0, 20.0)


if __name__ == "__main__":
    unittest.main()
