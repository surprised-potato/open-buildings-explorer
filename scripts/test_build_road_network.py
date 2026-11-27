import unittest

from shapely.geometry import MultiPolygon, Polygon, mapping

from build_road_network import clip_elements, outer_ring, ring_bbox


class NetworkBuilderHelperTests(unittest.TestCase):
    def test_outer_ring_uses_lat_lon_and_the_largest_part(self):
        small = Polygon([(0, 0), (0, 1), (1, 1), (1, 0)])
        big = Polygon([(10, 20), (10, 30), (15, 30), (15, 20)])
        ring = outer_ring(mapping(MultiPolygon([small, big])))
        self.assertEqual(len(ring), 4)
        self.assertTrue(all(20 <= lat <= 30 and 10 <= lon <= 15 for lat, lon in ring))

    def test_clip_keeps_ways_touching_the_box_and_centres_inside(self):
        box = ring_bbox([(10.0, 122.0), (10.1, 122.1)], 0.0)
        way_in = {"geometry": [{"lat": 9.9, "lon": 121.9}, {"lat": 10.05, "lon": 122.05}]}
        way_out = {"geometry": [{"lat": 11.0, "lon": 123.0}, {"lat": 11.1, "lon": 123.1}]}
        poi_in = {"type": "way", "center": {"lat": 10.05, "lon": 122.05}}
        node_out = {"type": "node", "lat": 12.0, "lon": 122.05}
        kept = clip_elements([way_in, way_out, poi_in, node_out], box)
        self.assertEqual(kept, [way_in, poi_in])


if __name__ == "__main__":
    unittest.main()
