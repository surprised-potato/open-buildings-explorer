#!/usr/bin/env python3
"""Unit tests for barangay analytics, DEM grid sampling, and 250m catchment grid generation."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, box

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from compute_barangay_analytics import (  # noqa: E402
    build_catchment_grid,
    compute_barangay_metrics,
    estimate_floors_from_height,
    sample_dem_grid,
)
from enrich_osm_buildings import geom_to_meters  # noqa: E402


class TestBarangayAnalytics(unittest.TestCase):
    def test_sample_dem_grid_bilinear_and_nodata(self) -> None:
        # 2x2 grid covering [0, 0, 10, 10]; row 0 is north (lat=10), row 1 is south (lat=0)
        grid = np.array([[100, 200], [0, 100]], dtype=np.int16)  # scale 0.1 -> 10,20 / 0,10
        bbox = [0.0, 0.0, 10.0, 10.0]

        center = sample_dem_grid(5.0, 5.0, grid, 2, 2, bbox, 0.1, -32768)
        self.assertIsNotNone(center)
        assert center is not None
        self.assertAlmostEqual(center, 10.0, places=5)

        nw = sample_dem_grid(0.0, 10.0, grid, 2, 2, bbox, 0.1, -32768)
        self.assertAlmostEqual(nw or 0.0, 10.0, places=5)

        self.assertIsNone(sample_dem_grid(-1.0, 5.0, grid, 2, 2, bbox, 0.1, -32768))

        nodata_grid = np.full((2, 2), -32768, dtype=np.int16)
        self.assertIsNone(sample_dem_grid(5.0, 5.0, nodata_grid, 2, 2, bbox, 0.1, -32768))

    def test_estimate_floors_from_height(self) -> None:
        self.assertEqual(estimate_floors_from_height(15.0, 4), 4)
        self.assertEqual(estimate_floors_from_height(9.6, None), 3)
        self.assertEqual(estimate_floors_from_height(2.0, None), 1)

    def test_compute_barangay_metrics_and_catchment_grid(self) -> None:
        b1_poly_deg = box(122.950, 10.670, 122.954, 10.674)
        b2_poly_deg = box(122.960, 10.670, 122.964, 10.674)
        b1_m = geom_to_meters(b1_poly_deg)
        b2_m = geom_to_meters(b2_poly_deg)

        barangays = [
            {
                "id": "brgy-1",
                "name": "Barangay 1",
                "geom_m": b1_m,
                "centroid": [122.952, 10.672],
                "bbox": [122.950, 10.670, 122.954, 10.674],
            },
            {
                "id": "brgy-2",
                "name": "Barangay 2",
                "geom_m": b2_m,
                "centroid": [122.962, 10.672],
                "bbox": [122.960, 10.670, 122.964, 10.674],
            },
        ]

        buildings = [
            {
                "id": "b1",
                "name": "Plaza Mall",
                "bclass": "commercial",
                "effective_height": 12.8,  # 4 floors
                "num_floors": None,
                "area_m2": 500.0,
                "lon": 122.951,
                "lat": 10.671,
                "rep_pt_m": geom_to_meters(box(122.9509, 10.6709, 122.9511, 10.6711)).representative_point(),
            },
            {
                "id": "b2",
                "name": None,
                "bclass": "house",
                "effective_height": 4.2,  # 1 floor
                "num_floors": 1,
                "area_m2": 100.0,
                "lon": 122.952,
                "lat": 10.672,
                "rep_pt_m": geom_to_meters(box(122.9519, 10.6719, 122.9521, 10.6721)).representative_point(),
            },
            {
                "id": "b3",
                "name": "Coastal Home",
                "bclass": "residential",
                "effective_height": 6.0,
                "num_floors": None,
                "area_m2": 120.0,
                "lon": 122.962,
                "lat": 10.672,
                "rep_pt_m": geom_to_meters(box(122.9619, 10.6719, 122.9621, 10.6721)).representative_point(),
            },
        ]

        building_pois = {
            "b1": {
                "id": "b1",
                "name": "Plaza Mall",
                "bclass": "commercial",
                "poi_count": 2,
                "center": [122.951, 10.671],
                "pois": [
                    {"osm_id": "node/1", "category": "retail"},
                    {"osm_id": "node/2", "category": "food"},
                ],
            }
        }

        # Green zone covering ~25% of Barangay 1
        green_m = [geom_to_meters(box(122.950, 10.670, 122.952, 10.672))]

        def fake_dem(lon: float, _lat: float) -> float:
            return 2.0 if lon < 122.9515 else 6.0

        citywide, rows = compute_barangay_metrics(
            barangays=barangays,
            buildings=buildings,
            building_pois=building_pois,
            green_geoms_m=green_m,
            dem_sampler=fake_dem,
        )

        by_name = {r["name"]: r for r in rows}
        brgy1 = by_name["Barangay 1"]
        self.assertEqual(brgy1["building_count"], 2)
        self.assertEqual(brgy1["commercial_count"], 1)
        self.assertEqual(brgy1["commercial_share_pct"], 50.0)
        self.assertEqual(brgy1["residential_count"], 1)
        self.assertEqual(brgy1["poi_count"], 2)
        self.assertEqual(brgy1["poi_by_category"], {"retail": 1, "food": 1})
        self.assertAlmostEqual(brgy1["est_gfa_m2"], 500.0 * 4 + 100.0 * 1, places=1)
        self.assertAlmostEqual(brgy1["mean_elev_m"], 4.0, places=1)
        self.assertEqual(brgy1["low_lying_pct"], 50.0)
        self.assertAlmostEqual(brgy1["green_space_pct"], 25.0, places=1)
        self.assertEqual(len(brgy1["top_hubs"]), 1)

        self.assertEqual(citywide["building_count"], 3)
        self.assertEqual(citywide["poi_count"], 2)

        # Catchment grid with an arterial road crossing b1's cell
        road_m = [geom_to_meters(LineString([(122.950, 10.671), (122.953, 10.671)]))]
        grid = build_catchment_grid(buildings, road_m, cell_size_m=250.0)
        self.assertEqual(grid["cell_size_m"], 250)
        self.assertGreaterEqual(len(grid["cells"]), 2)
        # At least one cell intersects the arterial road
        self.assertTrue(any(cell[6] == 1 for cell in grid["cells"]))


if __name__ == "__main__":
    unittest.main()
