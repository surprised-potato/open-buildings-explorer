import unittest

from extract_osm_region import in_bbox, is_econ_building, is_econ_poi, is_road


class ExtractFilterTests(unittest.TestCase):
    def test_road_filter_matches_trafficsim_importer(self):
        self.assertTrue(is_road({"highway": "residential"}))
        self.assertTrue(is_road({"highway": "primary_link"}))
        self.assertFalse(is_road({"highway": "footway"}))
        self.assertFalse(is_road({"highway": "service"}))
        self.assertFalse(is_road({"highway": "residential", "access": "private"}))

    def test_activity_filters(self):
        self.assertTrue(is_econ_poi({"amenity": "school"}))
        self.assertTrue(is_econ_poi({"shop": "bakery"}))
        self.assertFalse(is_econ_poi({"amenity": "bench"}))
        self.assertTrue(is_econ_building({"building": "school"}))
        self.assertFalse(is_econ_building({"building": "house"}))

    def test_bbox(self):
        box = (122.3, 9.35, 123.65, 11.1)  # west, south, east, north
        self.assertTrue(in_bbox(10.68, 122.95, box))
        self.assertFalse(in_bbox(10.3, 123.9, box))  # Cebu


if __name__ == "__main__":
    unittest.main()
