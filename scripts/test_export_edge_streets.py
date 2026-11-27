import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_edge_streets as x  # noqa: E402


class EdgeStreets(unittest.TestCase):
    def test_sample_points_quarters(self) -> None:
        pts = np.array([[0.0, 0.0], [4.0, 0.0]])
        got = x.sample_points(pts)
        self.assertEqual([round(p[0], 6) for p in got], [1.0, 2.0, 3.0])

    def test_majority_name(self) -> None:
        self.assertEqual(x.majority_name(["A", None, "A"]), "A")
        self.assertEqual(x.majority_name(["A", "B", "B"]), "B")
        self.assertIsNone(x.majority_name([None, None]))

    def test_read_edges_round_trip(self) -> None:
        # 2 nodes, 3 edges (odd, exercises padding), 5 points
        n_nodes, n_edges, n_pts = 2, 3, 5
        buf = struct.pack("<8I", x.MAGIC_BMOB, 1, n_nodes, n_edges, n_pts, 0, 3, 0)
        buf += b"\0" * (3 * n_nodes * 4)
        buf += b"\0" * ((n_edges * 2 + 2) * 2)
        buf += b"\0" * (7 * n_edges * 4)
        buf += np.array([0, 2, 3, 5], dtype="<u4").tobytes()
        coords = np.arange(10, dtype="<f4")
        buf += coords.tobytes()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "n.bin"
            p.write_bytes(buf)
            offs, c = x.read_edges(p)
        self.assertEqual(list(offs), [0, 2, 3, 5])
        self.assertEqual(c.shape, (5, 2))
        self.assertEqual(c[4, 1], 9.0)

    def test_name_edges_nearest_within_distance(self) -> None:
        from shapely.geometry import LineString

        mx, my = x.to_m(122.95, 10.676)
        road = LineString([(mx - 100, my), (mx + 100, my)])
        far = LineString([(mx - 100, my + 500), (mx + 100, my + 500)])
        offs = np.array([0, 2, 4])
        coords = np.array([[122.95, 10.676], [122.9501, 10.676], [122.95, 10.69], [122.9501, 10.69]])
        names, edge = x.name_edges(offs, coords, [("Main St", road), ("Far St", far)])
        self.assertEqual(names, ["Main St"])
        self.assertEqual(edge, [0, x.NO_NAME])


if __name__ == "__main__":
    unittest.main()
