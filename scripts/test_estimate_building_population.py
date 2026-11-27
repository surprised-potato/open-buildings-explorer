import unittest

import numpy as np

from estimate_building_population import distribute


class DistributeTests(unittest.TestCase):
    def test_totals_match_the_census_and_follow_weights(self):
        brgy = np.array([0, 0, 0, 1, 1, -1])
        w = np.array([1.0, 3.0, 0.0, 2.0, 2.0, 5.0])
        res = distribute(brgy, w, [100.0, 40.0])
        self.assertAlmostEqual(res[brgy == 0].sum(), 100.0)
        self.assertAlmostEqual(res[brgy == 1].sum(), 40.0)
        self.assertAlmostEqual(res[1] / res[0], 3.0)
        self.assertEqual(res[2], 0.0)       # no home weight, no residents
        self.assertEqual(res[5], 0.0)       # outside every barangay

    def test_equal_split_when_a_barangay_has_no_home_weight(self):
        res = distribute(np.array([0, 0]), np.array([0.0, 0.0]), [10.0])
        self.assertEqual(list(res), [5.0, 5.0])


if __name__ == "__main__":
    unittest.main()
