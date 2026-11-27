import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_osm_transport as f  # noqa: E402


class OsmTransport(unittest.TestCase):
    def test_coverage_counts_tags_per_class(self) -> None:
        ways = [
            {"tags": {"highway": "primary", "lanes": "4", "maxspeed": "40", "oneway": "yes"}},
            {"tags": {"highway": "primary"}},
            {"tags": {"highway": "residential", "oneway": "-1"}},
            {"tags": {"highway": "footway", "lanes": "1"}},  # not a counted class
        ]
        c = f.coverage(ways)
        self.assertEqual(c["primary"], {"ways": 2, "lanes": 1, "maxspeed": 1, "oneway": 1})
        self.assertEqual(c["residential"]["oneway"], 1)
        self.assertEqual(sum(v["ways"] for v in c.values()), 3)

    def test_route_record_keeps_only_route_ways_and_skips_empty(self) -> None:
        rel = {
            "id": 7,
            "tags": {"ref": "5", "name": "A - B", "from": "A", "to": "B", "route": "bus"},
            "members": [
                {"type": "way", "role": "", "geometry": [{"lat": 10.0, "lon": 122.9}, {"lat": 10.1, "lon": 122.95}]},
                {"type": "node", "role": "stop"},
                {"type": "way", "role": "platform", "geometry": [{"lat": 1, "lon": 1}]},
            ],
        }
        r = f.route_record(rel)
        self.assertEqual(r["ref"], "5")
        self.assertEqual(len(r["geometry"]), 1)
        self.assertIsNone(f.route_record({"id": 8, "tags": {}, "members": []}))

    def test_city_route_filter_and_geojson(self) -> None:
        city = {"id": 1, "ref": "1", "name": "Banago - Libertad", "operator": "", "mode": "bus", "from": "", "to": "", "geometry": [[[122.9, 10.6], [122.91, 10.61]]]}
        coach = {**city, "id": 2, "name": "Ceres Tours: Cebu - Bacolod"}
        out = {"routes": [city, coach], "stops": [{"name": "S", "lon": 122.9, "lat": 10.6}], "source": "x", "fetched_at": None}
        g = f.transit_geojson(out)
        kinds = [x["properties"]["kind"] for x in g["features"]]
        self.assertEqual(kinds, ["route", "stop"])


if __name__ == "__main__":
    unittest.main()
