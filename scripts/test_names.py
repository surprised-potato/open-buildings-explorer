import unittest

from names import best_match, lgu_key, match_key


class NameKeyTests(unittest.TestCase):
    def test_spellings_across_psa_overture_osm_agree(self):
        self.assertEqual(match_key("Barangay Ⅷ"), match_key("Barangay VIII"))   # Overture's roman numeral characters
        self.assertEqual(match_key("Barangay VIII"), match_key("Barangay 8"))
        self.assertEqual(match_key("Barangay 1 Pob."), match_key("Barangay 1 (Pob.)"))
        self.assertEqual(match_key("Brgy. Alangilan"), match_key("Alangilan"))
        self.assertEqual(match_key("Poblacion I"), "poblacion 1")

    def test_zones_and_poblacion_stay_distinct(self):
        self.assertNotEqual(match_key("Barangay Zone 1-A (Pob.)"), match_key("Barangay Zone 1-B (Pob.)"))
        self.assertEqual(match_key("Poblacion"), "poblacion")  # not emptied

    def test_close_spelling_only_when_unambiguous(self):
        self.assertEqual(best_match("caradio an", {"cardio an", "carabalan"}), "cardio an")
        self.assertIsNone(best_match("san jose", {"san juan", "san josef", "san jose x"}, cutoff=0.95))

    def test_lgu_names(self):
        self.assertEqual(lgu_key("CITY OF BAGO"), lgu_key("Bago"))
        self.assertEqual(lgu_key("Don Salvador Benedicto"), lgu_key("Salvador Benedicto"))


if __name__ == "__main__":
    unittest.main()
