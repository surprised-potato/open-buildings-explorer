import struct
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import estimate_building_zonal_values as z  # noqa: E402

ENTRIES = [
    {"barangay": "Barangay 1", "street": "LACSON ST", "vicinity": "", "group": "commercial", "value": 50000},
    {"barangay": "Barangay 1", "street": "LACSON ST", "vicinity": "", "group": "residential", "value": 12000},
    {"barangay": "Barangay 1", "street": "ALL OTHER STREETS", "vicinity": "", "group": "residential", "value": 5000},
    {"barangay": "Barangay 2", "street": "A. LOCSIN STREET", "vicinity": "", "group": "residential", "value": 9000},
    {"barangay": "Barangay 2", "street": "MABINI ST", "vicinity": "", "group": "residential", "value": 7000},
]


class ZonalEstimate(unittest.TestCase):
    def setUp(self):
        self.t = z.build_tables(ENTRIES)

    def test_normalize(self):
        self.assertEqual(z.normalize_street("A. Locsin Street"), "LOCSIN")
        self.assertEqual(z.normalize_street("17TH STREET"), "17TH")
        self.assertEqual(z.normalize_street("Bacolod-Murcia Road"), "BACOLOD MURCIA")

    def test_groups(self):
        self.assertEqual(z.land_use_group("retail"), "commercial")
        self.assertEqual(z.land_use_group("house"), "residential")
        self.assertEqual(z.land_use_group("warehouse"), "industrial")

    def test_tier1_group_specific(self):
        self.assertEqual(z.resolve_value(self.t, "barangay 1", ["Lacson Street"], "commercial")[:2], (50000, 1))
        self.assertEqual(z.resolve_value(self.t, "barangay 1", ["Lacson Street"], "residential")[:2], (12000, 1))

    def test_group_falls_back_to_residential(self):
        self.assertEqual(z.resolve_value(self.t, "barangay 2", ["Mabini Street"], "commercial")[:2], (7000, 1))

    def test_tier2_other_barangay(self):
        self.assertEqual(z.resolve_value(self.t, "barangay 2", ["Lacson Street"], "commercial")[:2], (50000, 2))

    def test_tier3_catch_all_then_median(self):
        self.assertEqual(z.resolve_value(self.t, "barangay 1", ["Unknown Rd"], "residential")[:2], (5000, 3))
        self.assertEqual(z.resolve_value(self.t, "barangay 2", [], "residential")[:2], (8000, 3))

    def test_tier4_city(self):
        v, tier, _ = z.resolve_value(self.t, None, [], "residential")
        self.assertEqual(tier, 4)

    def test_bin_roundtrip(self):
        ids = [str(uuid.UUID(int=5)), str(uuid.UUID(int=2)), "not-a-uuid"]
        with tempfile.TemporaryDirectory() as d:
            b, j = Path(d, "z.bin"), Path(d, "z.json")
            z.write_outputs(ids, [1000, 25000, 3], [1, 3, 4], [0, z.NO_STREET, z.NO_STREET], ["LACSON"], b, j, {})
            raw = b.read_bytes()
        magic, ver, n, ns = struct.unpack_from("<4I", raw)
        self.assertEqual((magic, ver, n, ns), (z.MAGIC, 1, 2, 1))
        self.assertEqual(raw[16:32], uuid.UUID(int=2).bytes)  # sorted
        self.assertEqual(struct.unpack_from("<2H", raw, 16 + 32), (5000, 200))


class PropertyAggregate(unittest.TestCase):
    def test_floors(self) -> None:
        self.assertEqual(z.floors_for(3, 99), 3)
        self.assertEqual(z.floors_for(None, 9.6), 3)
        self.assertEqual(z.floors_for(0, None), 1)

    def test_building_value_uses_coverage_and_cost(self) -> None:
        land, structure = z.building_value(1000, "residential", 60, 2)
        self.assertAlmostEqual(land, 1000 * 60 / 0.6)
        self.assertAlmostEqual(structure, 60 * 2 * 10700)

    def test_aggregate_totals_and_low_lying(self) -> None:
        rows = [
            {"barangay": "A", "group": "residential", "tier": 3, "footprint": 50.0, "land": 100.0, "structure": 50.0, "elev": 1.0},
            {"barangay": "A", "group": "commercial", "tier": 1, "footprint": 80.0, "land": 300.0, "structure": 100.0, "elev": 10.0},
            {"barangay": "B", "group": "residential", "tier": 3, "footprint": 40.0, "land": 10.0, "structure": 5.0, "elev": None},
        ]
        out = z.aggregate_barangay_property(rows)
        a = out["A"]
        self.assertEqual((a["buildings"], a["land"], a["structure"]), (2, 400, 150))
        self.assertEqual((a["lowLying"], a["lowLyingValue"]), (1, 150))
        self.assertEqual(a["tiers"], [1, 0, 1, 0])
        self.assertEqual(out["B"]["withElev"], 0)


class HazardPacking(unittest.TestCase):
    def test_pack_value(self) -> None:
        self.assertEqual(z.pack_hazard_value(0, None), 0)
        self.assertEqual(z.pack_hazard_value(3, 10.0), 3)
        self.assertEqual(z.pack_hazard_value(2, 1.0), 2 | z.LOW_LYING_BIT)
        self.assertEqual(z.pack_hazard_value(0, 2.9) & z.LOW_LYING_BIT, z.LOW_LYING_BIT)

    def test_surge_level_picks_lowest_reaching_advisory(self) -> None:
        from shapely.geometry import box
        from shapely.prepared import prep

        polys = [prep(box(0, 0, 1, 1)), prep(box(0, 0, 2, 2)), prep(box(0, 0, 3, 3)), prep(box(0, 0, 4, 4))]
        self.assertEqual(z.surge_level(box(0.2, 0.2, 0.4, 0.4), polys), 1)
        self.assertEqual(z.surge_level(box(2.5, 2.5, 2.6, 2.6), polys), 3)
        self.assertEqual(z.surge_level(box(9, 9, 9.5, 9.5), polys), 0)
        self.assertEqual(z.surge_level(box(0, 0, 1, 1), [None] * 4), 0)

    def test_hazard_bin_round_trip_and_aggregate(self) -> None:
        import tempfile
        import uuid as _uuid

        ids = [str(_uuid.UUID(int=i)) for i in (5, 1, 3)]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            z.write_hazard_bin(ids, [9, 2, 0], p / "h.bin", p / "h.json", {"x": 1})
            raw = (p / "h.bin").read_bytes()
        magic, _v, n, _k = struct.unpack_from("<4I", raw, 0)
        self.assertEqual((magic, n), (z.HAZARD_MAGIC, 3))
        vals = raw[16 + 16 * n :]
        self.assertEqual(list(vals), [2, 0, 9])  # sorted by id: 1, 3, 5
        rows = [
            {"barangay": "A", "group": "residential", "tier": 3, "footprint": 10.0, "land": 100.0, "structure": 50.0, "elev": 1.0, "surge": 2},
            {"barangay": "A", "group": "residential", "tier": 3, "footprint": 10.0, "land": 10.0, "structure": 5.0, "elev": 9.0, "surge": 0},
        ]
        a = z.aggregate_barangay_property(rows)["A"]
        self.assertEqual(a["surge"], [1, 0, 1, 0, 0])
        self.assertEqual(a["surgeValue"], [15, 0, 150, 0, 0])


if __name__ == "__main__":
    unittest.main()
