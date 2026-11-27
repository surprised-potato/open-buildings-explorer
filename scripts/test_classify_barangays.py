import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_barangays as c  # noqa: E402

F = {f: i for i, f in enumerate(c.FEATURES)}


def row(**kw: float) -> list[float]:
    base = {"log_density": 6, "coverage": 10, "commercial": 2, "log_poi_density": 3, "jobs_per_res": 0.2,
            "students_per_res": 0.2, "young": 0.35, "industrial": 0.5}
    base.update(kw)
    return [base[f] for f in c.FEATURES]


class Classify(unittest.TestCase):
    def test_labels_are_distinct_and_sensible(self) -> None:
        rng = np.random.RandomState(1)
        groups = {
            "core": dict(commercial=15, log_poi_density=5.5, jobs_per_res=2.0, log_density=7.5, coverage=30),
            "industrial": dict(industrial=25, commercial=3),
            "suburban": dict(log_density=4, coverage=2, log_poi_density=1.5, jobs_per_res=0.05),
            "residential": dict(),
        }
        names, rows, truth = [], [], {}
        for g, kw in groups.items():
            for i in range(8):
                r = np.asarray(row(**kw)) + rng.normal(0, 1e-9, len(c.FEATURES))
                names.append(f"{g}{i}")
                rows.append(r)
                truth[f"{g}{i}"] = g
        out = c.classify(names, np.asarray(rows), k=4, seed=3)
        self.assertEqual({o["type"] for o in out.values()}, set(groups))
        wrong = [n for n in names if out[n]["type"] != truth[n]]
        self.assertEqual(wrong, [])

    def test_kmeans_deterministic(self) -> None:
        x = np.random.RandomState(0).normal(size=(40, 3))
        self.assertTrue(np.array_equal(c.kmeans(x, 3, 5), c.kmeans(x, 3, 5)))


if __name__ == "__main__":
    unittest.main()
