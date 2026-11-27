import unittest

from pipeline import STAGES, STAGE_BY_NAME, fingerprint, missing_settings, plan
from place import get_place


class PipelineTests(unittest.TestCase):
    def test_dependencies_point_backwards(self):
        seen = set()
        for st in STAGES:
            for d in st.deps:
                self.assertIn(d, seen, f"{st.name} depends on later stage {d}")
            seen.add(st.name)

    def test_order_rules_from_datalayers_md(self):
        order = [s.name for s in STAGES]
        before = [("overrides", "analytics"), ("analytics", "zonal"), ("osm", "poi-votes"),
                  ("hazards", "building-values"), ("transport", "mobility"), ("mobility", "landcover")]
        for a, b in before:
            self.assertLess(order.index(a), order.index(b), f"{a} must run before {b}")

    def test_fingerprint_ripples_downstream(self):
        place = get_place("bacolod")
        st = STAGE_BY_NAME["analytics"]
        base = fingerprint(st, place, {"overrides": "a", "osm": "b", "dem": "c"})
        self.assertEqual(base, fingerprint(st, place, {"overrides": "a", "osm": "b", "dem": "c"}))
        self.assertNotEqual(base, fingerprint(st, place, {"overrides": "CHANGED", "osm": "b", "dem": "c"}))

    def test_offline_plan_never_runs_network_stages(self):
        place = get_place("bacolod")
        for d in plan(place, {}, offline=True, refresh=False, force=set(), selected=None):
            if d.stage.is_network(place):
                self.assertIn(d.action, ("adopt", "skip", "blocked"))

    def test_unconfigured_place_is_reported(self):
        self.assertEqual(missing_settings(get_place("bacolod")), [])
        from place import load_region, place_from_entry

        bare = place_from_entry({"slug": "x", "name": "X", "psa_name": "X", "psgc": "PH0000000000",
                                 "kind": "municipality", "status": "planned"}, load_region())
        self.assertIn("bbox", missing_settings(bare))


if __name__ == "__main__":
    unittest.main()
