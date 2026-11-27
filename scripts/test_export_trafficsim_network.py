#!/usr/bin/env python3
"""Unit tests for trafficsim_map -> mobility_network.bin + mobility_zones.json exporter."""

from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from export_trafficsim_network import (  # noqa: E402
    MAGIC_BBLD,
    MAGIC_BMOB,
    MODE_ORDER,
    SENTINEL_U16,
    apply_signal_delay,
    population_home_factors,
    read_ascii_grid,
    attach_zone_demand,
    compute_largest_scc,
    ensure_lon_lat_coords,
    export_trafficsim_network,
)


class TestExportTrafficsimNetwork(unittest.TestCase):
    def test_compute_largest_scc_filters_dead_ends_and_isolated_components(self) -> None:
        # SCC1: 0 <-> 1 <-> 2 (3 nodes); dead-end 2 -> 3; isolated pair 4 <-> 5
        src = np.array([0, 1, 1, 2, 2, 0, 2, 4, 5], dtype=np.int64)
        dst = np.array([1, 0, 2, 1, 0, 2, 3, 5, 4], dtype=np.int64)
        scc = compute_largest_scc(6, src, dst)
        self.assertEqual(scc, [0, 1, 2])

    def test_ensure_lon_lat_coords_handles_both_orders(self) -> None:
        lat_lon = np.array([[10.67, 122.95], [10.68, 122.96]], dtype=np.float64)
        fixed = ensure_lon_lat_coords(lat_lon)
        self.assertAlmostEqual(float(fixed[0, 0]), 122.95, places=4)
        self.assertAlmostEqual(float(fixed[0, 1]), 10.67, places=4)

        already_lon_lat = np.array([[122.95, 10.67], [122.96, 10.68]], dtype=np.float64)
        kept = ensure_lon_lat_coords(already_lon_lat)
        self.assertAlmostEqual(float(kept[0, 0]), 122.95, places=4)
        self.assertAlmostEqual(float(kept[0, 1]), 10.67, places=4)

    def test_export_end_to_end_binary_layout_spurs_and_dem(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state_dir = root / "state"
            state_dir.mkdir()
            out_dir = root / "out"
            dem_dir = root / "dem"
            dem_dir.mkdir()

            # 2x2 DEM grid covering [122.90, 10.60, 123.00, 10.70], scale=0.1 -> 10m..40m
            dem_grid = np.array([[300, 400], [100, 200]], dtype="<i2")
            dem_bin = dem_dir / "bacolod_dem_grid.bin"
            dem_bin.write_bytes(dem_grid.tobytes())
            dem_manifest = dem_dir / "dem_manifest.json"
            dem_manifest.write_text(
                json.dumps(
                    {
                        "grid": {
                            "file": dem_bin.name,
                            "width": 2,
                            "height": 2,
                            "bbox": [122.90, 10.60, 123.00, 10.70],
                            "scale": 0.1,
                            "nodata": -32768,
                        }
                    }
                ),
                encoding="utf-8",
            )

            # Nodes: 0,1,2 in Zone A; 3,4 in Zone B; 5 is a zone node; 6 is dead-end outside SCC
            lat = np.array([10.62, 10.62, 10.63, 10.67, 10.68, 10.625, 10.69], dtype=np.float64)
            lon = np.array([122.92, 122.93, 122.93, 122.97, 122.98, 122.925, 122.99], dtype=np.float64)
            is_zone = np.array([False, False, False, False, False, True, False], dtype=bool)

            # Directed cycle 0->1->2->3->4->0 + reverse edges + fast arterial 1->3 banned for tricycle
            # Plus dead-end 4->6 and zone connector 5->0
            edges = [
                (0, 1, 0.5, False),
                (1, 0, 0.5, False),
                (1, 2, 0.5, False),
                (2, 1, 0.5, False),
                (2, 3, 1.0, False),
                (3, 2, 1.0, False),
                (3, 4, 0.6, False),
                (4, 3, 0.6, False),
                (4, 0, 1.2, False),
                (0, 4, 1.2, False),
                (1, 3, 0.8, True),   # arterial shortcut banned for tricycle!
                (4, 6, 0.4, False),  # dead-end node 6 -> excluded from SCC
                (5, 0, 0.1, False),  # zone connector -> excluded
            ]
            src = np.array([e[0] for e in edges], dtype=np.int64)
            dst = np.array([e[1] for e in edges], dtype=np.int64)
            length = np.array([e[2] for e in edges], dtype=np.float64)
            capacity = np.array(
                [3200.0 if e[3] else 1000.0 for e in edges], dtype=np.float64
            )

            g_coords_list: list[list[float]] = []
            g_offs = [0]
            for s, d, _, _ in edges:
                # Store as (lat, lon) to also verify ensure_lon_lat_coords swaps properly
                g_coords_list.append([lat[s], lon[s]])
                g_coords_list.append([lat[d], lon[d]])
                g_offs.append(len(g_coords_list))

            t0_walk = length / 4.5 * 60.0
            t0_moto = length / 30.0 * 60.0
            t0_tri = length / 20.0 * 60.0
            t0_car = length / 40.0 * 60.0
            t0_puv = length / 22.0 * 60.0
            for idx, (_, _, _, ban_tri) in enumerate(edges):
                if ban_tri:
                    t0_tri[idx] = 1_000_000.0
                    t0_car[idx] = length[idx] / 70.0 * 60.0

            np.savez(
                state_dir / "state.npz",
                lat=lat,
                lon=lon,
                is_zone=is_zone,
                src=src,
                dst=dst,
                length=length,
                capacity=capacity,
                g_coords=np.array(g_coords_list, dtype=np.float64),
                g_offs=np.array(g_offs, dtype=np.uint32),
                **{
                    "t0:walk": t0_walk,
                    "t0:motorcycle": t0_moto,
                    "t0:tricycle": t0_tri,
                    "t0:car": t0_car,
                    "t0:puv": t0_puv,
                },
            )

            state_json = {
                "econ": {
                    "purposes": {
                        "hbw": {"name": "Home-work", "share": 0.48, "beta": 1.3, "attr": "jobs"},
                        "hbe": {"name": "Home-school", "share": 0.35, "beta": 1.8, "attr": "students"},
                        "hbo": {"name": "Home-other", "share": 0.17, "beta": 1.5, "attr": "commerce"},
                    }
                },
                "b_cost": -0.04,
                "b_dur": -0.05,
                "mode_cfg": [
                    {"id": "walk", "name": "Walk", "cost_per_km": 0.0, "asc": 0.0, "target": 0.18},
                    {"id": "motorcycle", "name": "Motorcycle", "cost_per_km": 3.5, "asc": -1.8, "target": 0.25},
                    {"id": "tricycle", "name": "Tricycle", "cost_per_km": 8.0, "asc": -0.8, "target": 0.10},
                    {"id": "car", "name": "Car", "cost_per_km": 9.0, "asc": -1.0, "target": 0.14},
                    {"id": "puv", "name": "Jeepney / bus", "cost_per_km": 2.4, "asc": -1.5, "target": 0.33},
                ],
                "modes": {},
                "zones": [
                    {
                        "id": "zone1",
                        "name": "Zone Alpha",
                        "polygon": [[10.61, 122.91], [10.61, 122.94], [10.64, 122.94], [10.64, 122.91]],
                        "pop": 1000,
                        "jobs": 300,
                        "students": 200,
                        "commerce": 0.5,
                    },
                    {
                        "id": "zone2",
                        "name": "Zone Beta",
                        "polygon": [[10.66, 122.96], [10.66, 122.99], [10.69, 122.99], [10.69, 122.96]],
                        "jobs": 800,
                        "students": 400,
                        "commerce": 1.2,
                    },
                ],
            }
            (state_dir / "state.json").write_text(json.dumps(state_json), encoding="utf-8")

            pois_path = root / "building_pois.json"
            pois_path.write_text(
                json.dumps(
                    {
                        "b1": {"center": [122.921, 10.621], "bclass": "residential", "pois": []},
                        "b2": {"center": [122.971, 10.671], "bclass": "school", "pois": [{"category": "education"}]},
                    }
                ),
                encoding="utf-8",
            )

            summary = export_trafficsim_network(
                state_dir=state_dir,
                buildings_pmtiles=root / "missing.pmtiles",
                building_pois_path=pois_path,
                dem_manifest_path=dem_manifest,
                out_dir=out_dir,
            )

            self.assertEqual(summary["n_nodes"], 5)
            self.assertEqual(summary["n_edges"], 11)  # 11 SCC edges (odd -> tests 2-byte padding!)
            self.assertEqual(summary["n_zones"], 2)
            self.assertEqual(summary["unreachable_count"], 0)

            zones_meta = json.loads((out_dir / "mobility_zones.json").read_text(encoding="utf-8"))
            self.assertEqual([m["id"] for m in zones_meta["modes"]], list(MODE_ORDER))
            self.assertEqual(zones_meta["routing_profiles"], ["motorized", "tricycle", "walk"])
            self.assertEqual(zones_meta["mode_profile_map"], {"walk": 2, "motorcycle": 0, "tricycle": 1, "car": 0, "puv": 0})
            self.assertEqual(zones_meta["zones"][1]["pop"], 0.0)
            modes_by_id = {m["id"]: m for m in zones_meta["modes"]}
            self.assertEqual(modes_by_id["puv"]["occupancy_min"], 15)
            self.assertEqual(modes_by_id["puv"]["occupancy_max"], 20)
            self.assertEqual(modes_by_id["puv"]["pcu"], 2.0)
            self.assertTrue(modes_by_id["puv"]["congests"])
            self.assertEqual(modes_by_id["walk"]["pcu"], 0.0)
            self.assertFalse(modes_by_id["walk"]["congests"])

            # Parse binary header and check alignment & coordinates
            raw = (out_dir / "mobility_network.bin").read_bytes()
            self.assertEqual(len(raw) % 4, 0)
            hdr = struct.unpack_from("<8I", raw, 0)
            self.assertEqual(hdr, (MAGIC_BMOB, 2, 5, 11, 22, 2, 3, 0))

            off = 32
            node_lon = np.frombuffer(raw, dtype="<f4", count=5, offset=off); off += 20
            node_lat = np.frombuffer(raw, dtype="<f4", count=5, offset=off); off += 20
            node_elev = np.frombuffer(raw, dtype="<f4", count=5, offset=off); off += 20
            self.assertTrue(np.all(node_elev > 10.0))

            edge_src = np.frombuffer(raw, dtype="<u2", count=11, offset=off); off += 22 + 2
            edge_dst = np.frombuffer(raw, dtype="<u2", count=11, offset=off); off += 22 + 2
            edge_len = np.frombuffer(raw, dtype="<f4", count=11, offset=off); off += 44
            edge_cap = np.frombuffer(raw, dtype="<f4", count=11, offset=off); off += 44
            self.assertAlmostEqual(float(np.max(edge_cap)), 3200.0, places=1)
            self.assertAlmostEqual(float(np.min(edge_cap)), 1000.0, places=1)
            edge_t0 = np.frombuffer(raw, dtype="<f4", count=55, offset=off); off += 220
            geom_offs = np.frombuffer(raw, dtype="<u4", count=12, offset=off); off += 48
            geom_coords = np.frombuffer(raw, dtype="<f4", count=44, offset=off); off += 176
            from_hub = np.frombuffer(raw, dtype="<u2", count=30, offset=off); off += 60
            self.assertEqual(off, len(raw))

            self.assertEqual(int(geom_offs[0]), 0)
            self.assertEqual(int(geom_offs[-1]), 22)
            # First geom point must be lon (~122.92), lat (~10.62)
            self.assertGreater(float(geom_coords[0]), 122.0)
            self.assertLess(float(geom_coords[1]), 12.0)
            # Tricycle block (index 2) keeps 1_000_000 * 60 sec penalty on arterial edge
            tri_block = edge_t0[2 * 11 : 3 * 11]
            self.assertGreater(float(np.max(tri_block)), 5e7)

            # Verify access_spurs walk edges form valid directed path from nodeIdx to hub_node
            for z in zones_meta["zones"]:
                hub = z["hub_node"]
                for nid_str, spurs in z["access_spurs"].items():
                    nid = int(nid_str)
                    self.assertEqual(len(spurs), 3)
                    for p_idx, edge_list in enumerate(spurs):
                        cur = nid
                        for e in edge_list:
                            self.assertEqual(int(edge_src[e]), cur)
                            cur = int(edge_dst[e])
                            if p_idx == 1:
                                # Tricycle spur must not use banned arterial edge
                                self.assertLess(float(tri_block[e]), 1e5)
                        self.assertEqual(cur, hub)

                # Verify fromHubPrevEdge root is SENTINEL_U16 and all other nodes reachable
                for p_idx in range(3):
                    base = (p_idx * 2 + z["idx"]) * 5
                    tree = from_hub[base : base + 5]
                    self.assertEqual(int(tree[hub]), SENTINEL_U16)
                    for n in range(5):
                        if n != hub:
                            self.assertNotEqual(int(tree[n]), SENTINEL_U16)

            # Road skims: symmetric-ish hub-to-hub matrices with zero diagonal and finite entries
            skims = zones_meta["skims"]
            for key in ("od_km", "od_min", "od_walk_km"):
                mat = skims[key]
                self.assertEqual(len(mat), 2)
                self.assertEqual(mat[0][0], 0.0)
                self.assertGreater(mat[0][1], 0.0)
                self.assertGreater(mat[1][0], 0.0)
            self.assertGreater(zones_meta["zones"][0]["nn_km"], 0.0)
            self.assertIn("work", zones_meta["zones"][1]["bldg_attr"])

            # Building table: header, zone offsets, node assignment, and to-hub next-edge trees
            braw = (out_dir / "mobility_buildings.bin").read_bytes()
            self.assertEqual(len(braw) % 4, 0)
            bhdr = struct.unpack_from("<8I", braw, 0)
            self.assertEqual(bhdr[0], MAGIC_BBLD)
            n_b, n_z, n_n, n_cls = bhdr[2], bhdr[3], bhdr[4], bhdr[5]
            self.assertEqual((n_z, n_n), (2, 5))
            self.assertEqual(n_b, summary["n_buildings"])
            self.assertGreaterEqual(n_b, 2)
            boff = 32
            zone_offs = np.frombuffer(braw, dtype="<u4", count=n_z + 1, offset=boff); boff += 4 * (n_z + 1)
            self.assertEqual(int(zone_offs[0]), 0)
            self.assertEqual(int(zone_offs[-1]), n_b)
            boff += 12 * n_b  # lon, lat, area
            b_node = np.frombuffer(braw, dtype="<u2", count=n_b, offset=boff)
            self.assertTrue(np.all(b_node < n_n))
            boff += (2 * n_b + 3) // 4 * 4
            boff += (n_b + 3) // 4 * 4  # cls
            boff += 4 * ((2 * n_b + 3) // 4 * 4)  # four weight arrays
            to_hub = np.frombuffer(braw, dtype="<u2", count=3 * n_z * n_n, offset=boff)
            boff += (2 * 3 * n_z * n_n + 3) // 4 * 4
            self.assertEqual(bhdr[6], 1)
            boff += 16 * n_b  # GERS id bytes
            self.assertEqual(boff, len(braw))
            for z in zones_meta["zones"]:
                hub = z["hub_node"]
                for p_idx in range(3):
                    base = (p_idx * 2 + z["idx"]) * 5
                    nxt = to_hub[base : base + 5]
                    self.assertEqual(int(nxt[hub]), SENTINEL_U16)
                    for n in range(5):
                        if n == hub:
                            continue
                        cur = n
                        for _ in range(5):
                            if cur == hub:
                                break
                            e = int(nxt[cur])
                            self.assertNotEqual(e, SENTINEL_U16)
                            self.assertEqual(int(edge_src[e]), cur)
                            cur = int(edge_dst[e])
                        self.assertEqual(cur, hub)
            self.assertTrue(n_cls >= 1)


class ZoneDemand(unittest.TestCase):
    def test_attach_by_name_and_missing_files(self) -> None:
        zones = [{"name": "A"}, {"name": "B"}]
        demand = {"barangays": {"A": {"prod": {"hbw": 1, "hbe": 2, "hbo": 3}, "mix": {"hbw": 0.1, "hbe": 0.3, "hbo": 0.6}}}}
        typology = {"barangays": {"B": {"type": "core", "label": "Urban core"}}}
        self.assertEqual(attach_zone_demand(zones, demand, typology), 1)
        self.assertEqual(zones[0]["prod"]["hbe"], 2)
        self.assertEqual(zones[1]["area_type"]["key"], "core")
        self.assertNotIn("prod", zones[1])
        bare = [{"name": "A"}]
        self.assertEqual(attach_zone_demand(bare, None, None), 0)
        self.assertEqual(bare, [{"name": "A"}])


class SignalDelay(unittest.TestCase):
    def test_delay_on_edges_into_signalised_nodes_only_for_vehicles(self) -> None:
        # nodes 0,1,2 about 100 m apart; signal sits on node 1; edges 0->1, 1->2
        lon = np.array([122.9500, 122.9509, 122.9518], dtype=np.float32)
        lat = np.full(3, 10.676, dtype=np.float32)
        dst = np.array([1, 2], dtype=np.uint16)
        t0 = np.full(5 * 2, 10.0, dtype=np.float32)
        n = apply_signal_delay(t0, dst, lon, lat, [[122.95091, 10.676]], 2, delay_sec=20.0)
        self.assertEqual(n, 1)
        blocks = t0.reshape(5, 2)
        self.assertTrue(np.allclose(blocks[0], [10, 10]))  # walk unchanged
        for b in range(1, 5):
            self.assertTrue(np.allclose(blocks[b], [30, 10]))  # only edge 0 -> node 1

    def test_far_signal_and_empty_list_do_nothing(self) -> None:
        lon = np.array([122.95, 122.951], dtype=np.float32)
        lat = np.full(2, 10.676, dtype=np.float32)
        t0 = np.full(5, 7.0, dtype=np.float32)
        self.assertEqual(apply_signal_delay(t0, np.array([1], dtype=np.uint16), lon, lat, [[123.5, 10.9]], 1), 0)
        self.assertEqual(apply_signal_delay(t0, np.array([1], dtype=np.uint16), lon, lat, [], 1), 0)
        self.assertTrue(np.allclose(t0, 7.0))


class PopulationGrid(unittest.TestCase):
    def test_factors_follow_relative_density_within_a_barangay(self) -> None:
        # cells: 0,1 in barangay 0; 2 in barangay 1; 3 outside; 4 in barangay 0 with people but no buildings
        cell_barangay = np.array([0, 0, 1, -1, 0])
        cell_pop = np.array([30.0, 30.0, 20.0, 5.0, 10.0])
        psa = np.array([50.0, 20.0])  # barangay 0 grid total 70 is rescaled to 50
        # buildings: three in cell 0, one in cell 1, two in cell 2, one outside the grid, one non-residential
        cell_idx = np.array([0, 0, 0, 1, 2, 2, -1, 1])
        home_w = np.array([1, 1, 1, 1, 1, 1, 1, 0], dtype=float)
        f, st = population_home_factors(cell_idx, home_w, cell_pop, cell_barangay, psa, blend=0.5)
        # scaled pops: c0 = c1 = 50/70*30 = 21.43, density 7.14 vs 21.43; mean over housed cells = 42.86/4 = 10.71
        self.assertAlmostEqual(f[0], 0.5 + 0.5 * (7.142857 / 10.714286), places=4)
        self.assertAlmostEqual(f[3], 0.5 + 0.5 * (21.428571 / 10.714286), places=4)
        self.assertAlmostEqual(f[4], 1.0, places=6)  # barangay 1 is uniform
        self.assertEqual(f[6], 1.0)  # outside the grid
        self.assertEqual(f[7], 1.0)  # non-residential
        # people in cell 4 (barangay 0) had no buildings: 14.29 of 50 + 20
        self.assertAlmostEqual(st["unplaced_share"], 50 / 70 * 10 / 70, places=4)

    def test_blend_zero_is_identity_and_clip_limits_extremes(self) -> None:
        cell_barangay = np.array([0, 0])
        cell_pop = np.array([1000.0, 1.0])
        idx = np.array([0, 1])
        w = np.array([1.0, 1.0])
        f0, _ = population_home_factors(idx, w, cell_pop, cell_barangay, np.array([1001.0]), blend=0.0)
        self.assertTrue(np.allclose(f0, 1.0))
        f1, _ = population_home_factors(idx, w, cell_pop, cell_barangay, np.array([1001.0]), blend=1.0)
        self.assertLessEqual(f1.max(), 5.0)
        self.assertGreaterEqual(f1.min(), 0.2)

    def test_read_ascii_grid(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "g.asc"
            p.write_text("ncols 2\nnrows 2\nxllcorner 10\nyllcorner 20\ncellsize 0.5\nNODATA_value -9999\n1 2\n-9999 4\n")
            arr, west, north, cs = read_ascii_grid(p)
        self.assertEqual((west, north, cs), (10.0, 21.0, 0.5))
        self.assertEqual(arr.tolist(), [[1.0, 2.0], [0.0, 4.0]])


if __name__ == "__main__":
    unittest.main()
