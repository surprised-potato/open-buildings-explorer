"""Registry checks, and a pin of Bacolod's settings to the constants the scripts used before the
place refactor. The network stages (Overture, Copernicus) and the OSM-dependent ones cannot be rerun offline to prove
identical output, so this test is what guards them."""
import unittest

from place import all_places, get_place, requested_slug


class PlaceRegistryTests(unittest.TestCase):
    def test_registry_covers_the_province(self):
        places = all_places()
        self.assertEqual(len(places), 32)
        self.assertEqual(sum(p.barangay_count for p in places), 662)
        self.assertEqual(len({p.slug for p in places}), 32)
        for p in places:
            self.assertRegex(p.psgc, r"^PH\d{7}000$")
            self.assertIn(p.kind, ("city", "municipality"))

    def test_bacolod_matches_the_old_constants(self):
        b = get_place("bacolod")
        self.assertEqual(b.status, "live")
        self.assertEqual(b.bbox, (122.89, 10.58, 123.14, 10.74))
        self.assertEqual(b.analysis_bbox, (122.88, 10.57, 123.15, 10.75))
        self.assertEqual(b.terrain_bbox, (122.85, 10.54, 123.20, 10.78))
        self.assertEqual(b.center, (122.9509, 10.6765))
        self.assertEqual(b.lat0, 10.676)
        self.assertEqual(b.planar_lat, 10.67)
        self.assertEqual(b.need("dem_grid"), [486, 324])
        self.assertEqual(b.need("osm_relation"), 11349321)
        self.assertEqual(len(b.barangays), 61)
        self.assertEqual(b.pmtiles("buildings").name, "bacolod_buildings.pmtiles")
        self.assertEqual(b.data_url_dir, "data/bacolod")
        self.assertEqual(b.psa_name, "CITY OF BACOLOD (Capital)")
        self.assertEqual(b.need("bir")["target_city"], "bacolod city")
        self.assertEqual(len(b.foreign_locality_suffixes()), 43)

    def test_new_places_exclude_themselves_from_foreign_localities(self):
        t = get_place("talisay")
        names = t.foreign_locality_suffixes()
        self.assertNotIn("talisay", names)
        self.assertIn("bacolod", names)
        self.assertIn("manila", names)

    def test_unconfigured_settings_fail_clearly(self):
        from place import PlaceNotConfigured

        with self.assertRaises(PlaceNotConfigured):
            _ = get_place("candoni").bbox

    def test_place_selection(self):
        self.assertEqual(requested_slug(["--place", "silay"]), "silay")
        self.assertEqual(requested_slug(["--place=bago"]), "bago")
        with self.assertRaises(SystemExit):
            get_place("atlantis")


if __name__ == "__main__":
    unittest.main()
