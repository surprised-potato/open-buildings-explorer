import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_poi_votes as v  # noqa: E402


class Votes(unittest.TestCase):
    def test_street_key_and_address_match(self):
        self.assertEqual(v.street_key("Bacolod Circumferential Road"), ("CIRCUMFERENTIAL",))
        keys = {v.street_key("Circumferential Road"), v.street_key("Lacson Street"), v.street_key("Rizal St")}
        got = v.streets_in_address("O square Building Circumferential Rd", keys)
        self.assertEqual(got, [("CIRCUMFERENTIAL",)])
        self.assertEqual(v.streets_in_address("Block 6 PHHC Brgy. Montevista", keys), [])

    def test_street_vote(self):
        self.assertEqual(v.street_vote([]), 0)
        self.assertEqual(v.street_vote([40, 900]), 1)
        self.assertEqual(v.street_vote([1400]), -1)
        self.assertEqual(v.street_vote([200]), 0)

    def test_phone_conflict_only_for_specific_numbers(self):
        far = {"a": {"center": [122.964, 10.646], "pois": [{"phone": "+639685767159"}]},
               "b": {"center": [122.9766, 10.6978], "pois": [{"phone": "0968 576 7159"}]}}
        self.assertEqual(v.phone_conflicts(far), {("a", 0), ("b", 0)})
        chain = {str(i): {"center": [122.9 + i * 0.01, 10.6], "pois": [{"phone": "09685767159"}]} for i in range(5)}
        self.assertEqual(v.phone_conflicts(chain), set())

    def test_score_and_trust(self):
        s, votes = v.score_poi({"source": "overture"}, [1400], True)
        self.assertEqual((s, v.trust_label(s)), (-2, "unverified"))
        s, _ = v.score_poi({"source": "osm"}, [], False)
        self.assertEqual(v.trust_label(s), "verified")
        # Barangay mismatch (-2) overrides street:+1 -> -1 ('unverified')
        s, votes = v.score_poi({"source": "overture"}, [20], False, barangay_v=-2)
        self.assertEqual((s, v.trust_label(s)), (-1, "unverified"))
        self.assertIn("barangay:-2", votes)

    def test_extract_mentioned_barangays_and_vote(self):
        from shapely.geometry import Point, box

        aliases = {
            "cabug": "Cabug",
            "sum-ag": "Sum-ag",
            "villamonte": "Villamonte",
            "handumanan": "Handumanan",
            "alijis": "Alijis",
            "granada": "Granada",
            "alangilan": "Alangilan",
        }
        valid = set(aliases.values()) | {"Barangay 12"}
        self.assertEqual(
            v.extract_mentioned_barangays("Block 107 Lot 22 Mainroad, Deca Homes, Cabug", aliases, valid),
            ["Cabug"],
        )
        self.assertEqual(
            v.extract_mentioned_barangays("Unit A204 2/F SM City Reclamation Area, Brgy. 12", aliases, valid),
            ["Barangay 12"],
        )
        self.assertEqual(
            v.extract_mentioned_barangays("Earl Carol St. Sum-ag", aliases, valid),
            ["Sum-ag"],
        )
        self.assertEqual(
            v.extract_mentioned_barangays("Circumferential Rd, Brgy Villamonte", aliases, valid),
            ["Villamonte"],
        )
        # Road names containing barangay words must NOT trigger false claims
        self.assertEqual(v.extract_mentioned_barangays("Handumanan Access Road", aliases, valid), [])
        self.assertEqual(v.extract_mentioned_barangays("Alijis-Murcia Road", aliases, valid), [])
        self.assertEqual(v.extract_mentioned_barangays("Granada Alangilan Road", aliases, valid), [])

        geoms = {"Cabug": box(0.0, 0.0, 1000.0, 1000.0), "Barangay 12": box(5000.0, 5000.0, 5500.0, 5500.0)}
        # Inside Cabug -> +1
        self.assertEqual(v.barangay_vote(Point(500.0, 500.0), "Deca Homes, Cabug", geoms, aliases), 1)
        # Within 250 m border tolerance -> +1
        self.assertEqual(v.barangay_vote(Point(1150.0, 500.0), "Deca Homes, Cabug", geoms, aliases), 1)
        # 5 km away -> -2
        self.assertEqual(v.barangay_vote(Point(5200.0, 5200.0), "Deca Homes, Cabug", geoms, aliases), -2)
        # No barangay mentioned -> abstain (0)
        self.assertEqual(v.barangay_vote(Point(5200.0, 5200.0), "Gatuslao St", geoms, aliases), 0)


if __name__ == "__main__":
    unittest.main()
