import unittest

from shapely.geometry import box, mapping

from fix_bata_boundary import merge_gap_into_bata


def feat(name, level, g):
    return {"type": "Feature", "geometry": mapping(g), "properties": {"name": name, "level": level}}


class FixBataBoundaryTests(unittest.TestCase):
    def test_gap_touching_bata_is_merged_and_idempotent(self):
        fc = {"features": [
            feat("Bacolod City", "city", box(0, 0, 0.07, 0.03)),
            feat("Bata", "barangay", box(0, 0, 0.03, 0.03)),
            feat("Other", "barangay", box(0.05, 0, 0.07, 0.03)),
        ]}
        res = merge_gap_into_bata(fc)
        self.assertIsNotNone(res)
        bata = next(f for f in fc["features"] if f["properties"]["name"] == "Bata")
        self.assertGreater(bata["properties"]["bbox"][2], 0.049)
        self.assertIsNone(merge_gap_into_bata(fc))


if __name__ == "__main__":
    unittest.main()
