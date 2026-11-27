#!/usr/bin/env python3
"""Precompute per-barangay urban analytics and a 250 m catchment grid for one place (default Bacolod City).

Outputs:
  - public/data/bacolod/barangay_analytics.json
  - public/data/bacolod/catchment_grid.json
  - public/data/bacolod/boundaries.geojson (enriched in-place with choropleth metrics)
  - public/data/bacolod/manifest.json (files updated with barangay_analytics + catchment_grid)
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
from shapely.geometry import Point, box, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

try:
    from scripts.enrich_osm_buildings import (
        COMMERCIAL_CLASSES,
        M_PER_DEG_LAT,
        M_PER_DEG_LON,
        coerce_polygonal,
        geom_to_meters,
        load_stitched_buildings,
    )
    from scripts.fetch_bacolod import OUT_DIR, PLACE
except ImportError:
    from enrich_osm_buildings import (  # type: ignore[no-redef]
        COMMERCIAL_CLASSES,
        M_PER_DEG_LAT,
        M_PER_DEG_LON,
        coerce_polygonal,
        geom_to_meters,
        load_stitched_buildings,
    )
    from fetch_bacolod import OUT_DIR, PLACE  # type: ignore[no-redef]

DEFAULT_BUILDINGS_PMTILES = PLACE.pmtiles("buildings")
DEFAULT_ROADS_PMTILES = PLACE.pmtiles("roads")
DEFAULT_BASE_PMTILES = PLACE.pmtiles("base")
DEFAULT_BOUNDARIES = OUT_DIR / "boundaries.geojson"
DEFAULT_BUILDING_POIS = OUT_DIR / "building_pois.json"
DEFAULT_DEM_MANIFEST = OUT_DIR / "dem" / "dem_manifest.json"
DEFAULT_OUT_ANALYTICS = OUT_DIR / "barangay_analytics.json"
DEFAULT_OUT_CATCHMENT = OUT_DIR / "catchment_grid.json"
DEFAULT_MANIFEST = OUT_DIR / "manifest.json"

RESIDENTIAL_ANALYTICS_CLASSES = {
    "residential",
    "house",
    "apartments",
    "detached",
    "semidetached_house",
    "terrace",
    "bungalow",
    "dormitory",
}

INDUSTRIAL_ANALYTICS_CLASSES = {
    "industrial",
    "warehouse",
    "factory",
    "manufacture",
}

CIVIC_EDU_HEALTH_CLASSES = {
    "school",
    "college",
    "university",
    "education",
    "hospital",
    "healthcare",
    "clinic",
    "civic",
    "public",
    "government",
    "religious",
    "church",
    "cathedral",
    "chapel",
    "mosque",
    "temple",
}

GREEN_LANDUSE_CLASSES = {
    "park",
    "forest",
    "grass",
    "recreation_ground",
    "meadow",
    "garden",
    "village_green",
}

ARTERIAL_ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary"}


def sample_dem_grid(
    lon: float,
    lat: float,
    grid: np.ndarray,
    width: int,
    height: int,
    bbox: list[float] | tuple[float, float, float, float],
    scale: float,
    nodata: int,
) -> float | None:
    """Bilinearly sample elevation (m ASL) matching src/utils/demSampler.ts."""
    west, south, east, north = bbox
    if (
        not math.isfinite(lon)
        or not math.isfinite(lat)
        or lon < west
        or lon > east
        or lat < south
        or lat > north
    ):
        return None

    u = (lon - west) / (east - west)
    v = (north - lat) / (north - south)

    fx = max(0.0, min(float(width - 1), u * (width - 1)))
    fy = max(0.0, min(float(height - 1), v * (height - 1)))

    x0 = int(math.floor(fx))
    y0 = int(math.floor(fy))
    x1 = min(width - 1, x0 + 1)
    y1 = min(height - 1, y0 + 1)

    dx = fx - x0
    dy = fy - y0

    corners = (
        (int(grid[y0, x0]), (1.0 - dx) * (1.0 - dy)),
        (int(grid[y0, x1]), dx * (1.0 - dy)),
        (int(grid[y1, x0]), (1.0 - dx) * dy),
        (int(grid[y1, x1]), dx * dy),
    )

    weighted_sum = 0.0
    total_weight = 0.0
    fallback_sum = 0.0
    fallback_count = 0

    for raw, weight in corners:
        if raw == nodata:
            continue
        meters = raw * scale
        fallback_sum += meters
        fallback_count += 1
        if weight > 0.0:
            weighted_sum += meters * weight
            total_weight += weight

    if fallback_count == 0:
        return None
    if total_weight > 0.0:
        return weighted_sum / total_weight
    return fallback_sum / fallback_count


def load_dem_sampler(
    dem_manifest_path: Path,
) -> Callable[[float, float], float | None]:
    """Load bacolod_dem_grid.bin using dem_manifest.json and return a sampler callable."""
    if not dem_manifest_path.exists():
        print(f"DEM manifest not found at {dem_manifest_path}; elevation stats will be null.")
        return lambda _lon, _lat: None

    manifest = json.loads(dem_manifest_path.read_text(encoding="utf-8"))
    grid_meta = manifest["grid"]
    grid_path = dem_manifest_path.parent / Path(grid_meta["file"]).name
    if not grid_path.exists():
        # Fallback relative to public/
        grid_path = OUT_DIR.parent.parent / grid_meta["file"]

    width = int(grid_meta["width"])
    height = int(grid_meta["height"])
    bbox = [float(x) for x in grid_meta["bbox"]]
    scale = float(grid_meta["scale"])
    nodata = int(grid_meta["nodata"])

    arr = np.fromfile(grid_path, dtype="<i2").reshape((height, width))
    return lambda lon, lat: sample_dem_grid(
        lon, lat, arr, width, height, bbox, scale, nodata
    )


def estimate_floors_from_height(
    effective_height: float | None, num_floors: int | float | None
) -> int:
    """Return explicit num_floors if positive, else infer floors from effective_height / 3.2m."""
    if num_floors is not None and math.isfinite(float(num_floors)) and float(num_floors) > 0:
        return int(round(float(num_floors)))
    if effective_height is not None and math.isfinite(float(effective_height)) and float(effective_height) > 0:
        return max(1, int(round(float(effective_height) / 3.2)))
    return 1


def compute_barangay_metrics(
    barangays: list[dict[str, Any]],
    buildings: list[dict[str, Any]],
    building_pois: dict[str, dict[str, Any]],
    green_geoms_m: list[Any],
    dem_sampler: Callable[[float, float], float | None],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Aggregate urban form, commercial mix, POIs, elevation, and green space per barangay."""
    if not barangays:
        return {}, []

    brgy_geoms = [b["geom_m"] for b in barangays]
    brgy_areas_m2 = [float(g.area) for g in brgy_geoms]
    brgy_tree = STRtree(brgy_geoms)

    green_tree = STRtree(green_geoms_m) if green_geoms_m else None

    # Per-barangay accumulators
    acc: list[dict[str, Any]] = []
    for idx, b in enumerate(barangays):
        acc.append(
            {
                "building_count": 0,
                "footprint_m2": 0.0,
                "est_gfa_m2": 0.0,
                "height_sum": 0.0,
                "max_height_m": 0.0,
                "commercial_count": 0,
                "mixed_use_count": 0,
                "residential_count": 0,
                "industrial_count": 0,
                "civic_edu_health_count": 0,
                "unknown_count": 0,
                "poi_count": 0,
                "poi_by_category": collections.Counter(),
                "elev_sum": 0.0,
                "elev_count": 0,
                "min_elev_m": None,
                "max_elev_m": None,
                "low_lying_count": 0,
                "hubs": [],
                "area_km2": round(brgy_areas_m2[idx] / 1_000_000.0, 3),
            }
        )

    for bldg in buildings:
        pt_m: Point = bldg["rep_pt_m"]
        candidates = brgy_tree.query(pt_m, predicate="intersects")
        if len(candidates) > 0:
            brgy_idx = int(min(candidates, key=lambda i: brgy_areas_m2[int(i)]))
        else:
            nearest_idx = int(brgy_tree.nearest(pt_m))
            if brgy_geoms[nearest_idx].distance(pt_m) <= 50.0:
                brgy_idx = nearest_idx
            else:
                continue

        st = acc[brgy_idx]
        area_m2 = float(bldg.get("area_m2") or 0.0)
        eff_h = float(bldg.get("effective_height") or 6.0)
        floors = estimate_floors_from_height(eff_h, bldg.get("num_floors"))
        bclass = str(bldg.get("bclass") or "unknown").lower().strip()

        st["building_count"] += 1
        st["footprint_m2"] += area_m2
        st["est_gfa_m2"] += area_m2 * floors
        st["height_sum"] += eff_h
        if eff_h > st["max_height_m"]:
            st["max_height_m"] = eff_h

        if bclass in COMMERCIAL_CLASSES:
            st["commercial_count"] += 1
            if bclass == "mixed_use":
                st["mixed_use_count"] += 1
        elif bclass in RESIDENTIAL_ANALYTICS_CLASSES:
            st["residential_count"] += 1
        elif bclass in INDUSTRIAL_ANALYTICS_CLASSES:
            st["industrial_count"] += 1
        elif bclass in CIVIC_EDU_HEALTH_CLASSES:
            st["civic_edu_health_count"] += 1
        elif bclass == "unknown":
            st["unknown_count"] += 1

        elev = dem_sampler(float(bldg["lon"]), float(bldg["lat"]))
        if elev is not None and math.isfinite(elev):
            st["elev_sum"] += elev
            st["elev_count"] += 1
            if st["min_elev_m"] is None or elev < st["min_elev_m"]:
                st["min_elev_m"] = elev
            if st["max_elev_m"] is None or elev > st["max_elev_m"]:
                st["max_elev_m"] = elev
            if elev < 3.0:
                st["low_lying_count"] += 1

        bid = bldg["id"]
        poi_rec = building_pois.get(bid)
        if poi_rec:
            p_count = int(poi_rec.get("poi_count") or len(poi_rec.get("pois") or []))
            st["poi_count"] += p_count
            for poi in poi_rec.get("pois") or []:
                cat = str(poi.get("category") or "other")
                st["poi_by_category"][cat] += 1
            st["hubs"].append(
                {
                    "id": bid,
                    "name": poi_rec.get("name") or bldg.get("name") or f"{bclass} hub",
                    "bclass": bclass,
                    "poi_count": p_count,
                    "center": poi_rec.get("center") or [round(float(bldg["lon"]), 6), round(float(bldg["lat"]), 6)],
                }
            )

    results: list[dict[str, Any]] = []
    city_totals = {
        "barangays": len(barangays),
        "area_km2": 0.0,
        "building_count": 0,
        "footprint_m2": 0.0,
        "est_gfa_m2": 0.0,
        "commercial_count": 0,
        "mixed_use_count": 0,
        "residential_count": 0,
        "industrial_count": 0,
        "civic_edu_health_count": 0,
        "poi_count": 0,
        "low_lying_buildings": 0,
        "elev_buildings": 0,
        "elev_sum": 0.0,
        "green_area_m2": 0.0,
    }

    for idx, b in enumerate(barangays):
        st = acc[idx]
        b_geom_m = brgy_geoms[idx]
        area_m2 = brgy_areas_m2[idx]
        area_km2 = max(area_m2 / 1_000_000.0, 0.0001)
        b_count = st["building_count"]

        green_area_m2 = 0.0
        if green_tree is not None and area_m2 > 0:
            hits = green_tree.query(b_geom_m, predicate="intersects")
            if len(hits) > 0:
                clipped = [b_geom_m.intersection(green_geoms_m[int(hi)]) for hi in hits]
                clipped = [g for g in clipped if not g.is_empty]
                if clipped:
                    green_area_m2 = float(unary_union(clipped).area)

        green_pct = min(100.0, round(green_area_m2 / area_m2 * 100.0, 1)) if area_m2 > 0 else 0.0
        built_cov_pct = min(100.0, round(st["footprint_m2"] / area_m2 * 100.0, 1)) if area_m2 > 0 else 0.0
        comm_share_pct = round(st["commercial_count"] / max(1, b_count) * 100.0, 1) if b_count > 0 else 0.0
        mean_h = round(st["height_sum"] / b_count, 1) if b_count > 0 else 0.0
        mean_elev = round(st["elev_sum"] / st["elev_count"], 1) if st["elev_count"] > 0 else None
        low_lying_pct = (
            round(st["low_lying_count"] / st["elev_count"] * 100.0, 1)
            if st["elev_count"] > 0
            else 0.0
        )

        top_hubs = sorted(st["hubs"], key=lambda h: (-h["poi_count"], h["name"]))[:3]

        item = {
            "id": b["id"],
            "name": b["name"],
            "centroid": b["centroid"],
            "bbox": b["bbox"],
            "area_km2": round(area_km2, 3),
            "building_count": b_count,
            "building_density_per_km2": round(b_count / area_km2, 1),
            "footprint_m2": round(st["footprint_m2"], 1),
            "built_coverage_pct": built_cov_pct,
            "est_gfa_m2": round(st["est_gfa_m2"], 1),
            "mean_height_m": mean_h,
            "max_height_m": round(st["max_height_m"], 1),
            "commercial_count": st["commercial_count"],
            "commercial_share_pct": comm_share_pct,
            "mixed_use_count": st["mixed_use_count"],
            "residential_count": st["residential_count"],
            "industrial_count": st["industrial_count"],
            "civic_edu_health_count": st["civic_edu_health_count"],
            "unknown_count": st["unknown_count"],
            "poi_count": st["poi_count"],
            "poi_density_per_km2": round(st["poi_count"] / area_km2, 1),
            "poi_by_category": dict(st["poi_by_category"].most_common()),
            "mean_elev_m": mean_elev,
            "min_elev_m": round(st["min_elev_m"], 1) if st["min_elev_m"] is not None else None,
            "max_elev_m": round(st["max_elev_m"], 1) if st["max_elev_m"] is not None else None,
            "low_lying_pct": low_lying_pct,
            "green_space_pct": green_pct,
            "top_hubs": top_hubs,
        }
        results.append(item)

        city_totals["area_km2"] += area_km2
        city_totals["building_count"] += b_count
        city_totals["footprint_m2"] += st["footprint_m2"]
        city_totals["est_gfa_m2"] += st["est_gfa_m2"]
        city_totals["commercial_count"] += st["commercial_count"]
        city_totals["mixed_use_count"] += st["mixed_use_count"]
        city_totals["residential_count"] += st["residential_count"]
        city_totals["industrial_count"] += st["industrial_count"]
        city_totals["civic_edu_health_count"] += st["civic_edu_health_count"]
        city_totals["poi_count"] += st["poi_count"]
        city_totals["low_lying_buildings"] += st["low_lying_count"]
        city_totals["elev_buildings"] += st["elev_count"]
        city_totals["elev_sum"] += st["elev_sum"]
        city_totals["green_area_m2"] += green_area_m2

    total_area_m2 = city_totals["area_km2"] * 1_000_000.0
    citywide = {
        "barangays": city_totals["barangays"],
        "area_km2": round(city_totals["area_km2"], 2),
        "building_count": city_totals["building_count"],
        "footprint_m2": round(city_totals["footprint_m2"], 1),
        "built_coverage_pct": round(city_totals["footprint_m2"] / max(1.0, total_area_m2) * 100.0, 1),
        "est_gfa_m2": round(city_totals["est_gfa_m2"], 1),
        "commercial_count": city_totals["commercial_count"],
        "commercial_share_pct": round(
            city_totals["commercial_count"] / max(1, city_totals["building_count"]) * 100.0, 2
        ),
        "mixed_use_count": city_totals["mixed_use_count"],
        "residential_count": city_totals["residential_count"],
        "industrial_count": city_totals["industrial_count"],
        "civic_edu_health_count": city_totals["civic_edu_health_count"],
        "poi_count": city_totals["poi_count"],
        "mean_elev_m": (
            round(city_totals["elev_sum"] / city_totals["elev_buildings"], 1)
            if city_totals["elev_buildings"] > 0
            else None
        ),
        "low_lying_pct": (
            round(city_totals["low_lying_buildings"] / city_totals["elev_buildings"] * 100.0, 1)
            if city_totals["elev_buildings"] > 0
            else 0.0
        ),
        "green_space_pct": round(city_totals["green_area_m2"] / max(1.0, total_area_m2) * 100.0, 1),
    }

    results.sort(key=lambda r: (-r["building_count"], r["name"]))
    return citywide, results


def build_catchment_grid(
    buildings: list[dict[str, Any]],
    arterial_road_geoms_m: list[Any],
    cell_size_m: float = 250.0,
) -> dict[str, Any]:
    """Bin buildings into 250m grid cells for fast client-side site-selection catchment scoring."""
    cells: dict[tuple[int, int], list[float]] = {}
    for bldg in buildings:
        pt_m: Point = bldg["rep_pt_m"]
        cx = int(math.floor(pt_m.x / cell_size_m))
        cy = int(math.floor(pt_m.y / cell_size_m))
        key = (cx, cy)
        slot = cells.get(key)
        if slot is None:
            # [total_buildings, res_buildings, res_footprint_m2, commercial_buildings]
            slot = [0, 0, 0.0, 0]
            cells[key] = slot

        slot[0] += 1
        bclass = str(bldg.get("bclass") or "unknown").lower().strip()
        if bclass in RESIDENTIAL_ANALYTICS_CLASSES:
            slot[1] += 1
            slot[2] += float(bldg.get("area_m2") or 0.0)
        elif bclass in COMMERCIAL_CLASSES:
            slot[3] += 1

    road_tree = STRtree(arterial_road_geoms_m) if arterial_road_geoms_m else None

    rows: list[list[Any]] = []
    for (cx, cy), (total_b, res_b, res_area, comm_b) in sorted(cells.items()):
        x0 = cx * cell_size_m
        y0 = cy * cell_size_m
        center_lon = (x0 + 0.5 * cell_size_m) / M_PER_DEG_LON
        center_lat = (y0 + 0.5 * cell_size_m) / M_PER_DEG_LAT

        has_arterial = 0
        if road_tree is not None:
            cell_box = box(x0, y0, x0 + cell_size_m, y0 + cell_size_m)
            if len(road_tree.query(cell_box, predicate="intersects")) > 0:
                has_arterial = 1

        rows.append(
            [
                round(center_lon, 5),
                round(center_lat, 5),
                int(total_b),
                int(res_b),
                int(round(res_area)),
                int(comm_b),
                has_arterial,
            ]
        )

    return {
        "cell_size_m": int(cell_size_m),
        "columns": [
            "lon",
            "lat",
            "total_buildings",
            "residential_buildings",
            "residential_footprint_m2",
            "commercial_buildings",
            "has_arterial_road",
        ],
        "cells": rows,
    }


def _load_green_geoms_m(base_pmtiles_path: Path, tmp_dir: Path) -> list[Any]:
    """Extract and stitch green land-use polygons from bacolod_base.pmtiles."""
    if not base_pmtiles_path.exists():
        return []
    extracted = tmp_dir / "base_green.geojsonl"
    subprocess.run(
        [
            "ogr2ogr",
            "-f",
            "GeoJSONSeq",
            "-oo",
            "ZOOM_LEVEL=15",
            "-oo",
            "CLIP=NO",
            str(extracted),
            str(base_pmtiles_path),
            "base",
        ],
        check=True,
    )
    grouped: dict[str, list[Any]] = {}
    with extracted.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            props = feat.get("properties") or {}
            if props.get("kind") != "land_use":
                continue
            bclass = str(props.get("bclass") or "").lower().strip()
            if bclass not in GREEN_LANDUSE_CLASSES:
                continue
            fid = str(props.get("id") or "")
            if not fid:
                continue
            grouped.setdefault(fid, []).append(shape(feat["geometry"]))

    green_geoms_m: list[Any] = []
    for geoms in grouped.values():
        merged = geoms[0] if len(geoms) == 1 else unary_union(geoms)
        poly = coerce_polygonal(merged)
        if poly is not None:
            green_geoms_m.append(geom_to_meters(poly))
    return green_geoms_m


def _load_arterial_roads_m(roads_pmtiles_path: Path, tmp_dir: Path) -> list[Any]:
    """Extract motorway/trunk/primary/secondary road geometries in local meters."""
    if not roads_pmtiles_path.exists():
        return []
    extracted = tmp_dir / "roads_arterial.geojsonl"
    subprocess.run(
        [
            "ogr2ogr",
            "-f",
            "GeoJSONSeq",
            "-oo",
            "ZOOM_LEVEL=16",
            "-oo",
            "CLIP=NO",
            str(extracted),
            str(roads_pmtiles_path),
            "roads",
        ],
        check=True,
    )
    roads_m: list[Any] = []
    with extracted.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            props = feat.get("properties") or {}
            rclass = str(props.get("rclass") or "").lower().strip()
            if rclass not in ARTERIAL_ROAD_CLASSES:
                continue
            geom = shape(feat["geometry"])
            if not geom.is_empty:
                roads_m.append(geom_to_meters(geom))
    return roads_m


def compute_and_write_analytics(
    pmtiles_path: Path = DEFAULT_BUILDINGS_PMTILES,
    roads_pmtiles_path: Path = DEFAULT_ROADS_PMTILES,
    base_pmtiles_path: Path = DEFAULT_BASE_PMTILES,
    boundaries_path: Path = DEFAULT_BOUNDARIES,
    building_pois_path: Path = DEFAULT_BUILDING_POIS,
    dem_manifest_path: Path = DEFAULT_DEM_MANIFEST,
    out_analytics_path: Path = DEFAULT_OUT_ANALYTICS,
    out_catchment_path: Path = DEFAULT_OUT_CATCHMENT,
    manifest_path: Path = DEFAULT_MANIFEST,
) -> dict[str, Any]:
    """Run the offline barangay analytics & catchment grid pipeline."""
    if not pmtiles_path.exists():
        raise FileNotFoundError(f"Buildings PMTiles not found: {pmtiles_path}")
    if not boundaries_path.exists():
        raise FileNotFoundError(f"Boundaries GeoJSON not found: {boundaries_path}")

    boundaries_fc = json.loads(boundaries_path.read_text(encoding="utf-8"))
    barangays: list[dict[str, Any]] = []
    for feat in boundaries_fc.get("features", []):
        props = feat.get("properties") or {}
        if props.get("level") != "barangay":
            continue
        geom = coerce_polygonal(shape(feat["geometry"]))
        if geom is None:
            continue
        barangays.append(
            {
                "id": str(props.get("id") or props.get("name")),
                "name": str(props.get("name")),
                "geom_m": geom_to_meters(geom),
                "centroid": [props.get("centroid_lon"), props.get("centroid_lat")],
                "bbox": props.get("bbox"),
            }
        )

    building_pois: dict[str, dict[str, Any]] = {}
    if building_pois_path.exists():
        building_pois = json.loads(building_pois_path.read_text(encoding="utf-8"))

    dem_sampler = load_dem_sampler(dem_manifest_path)

    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_analytics_") as tmp:
        tmp_dir = Path(tmp)
        building_ids, building_geoms_deg, building_geoms_m, building_props = load_stitched_buildings(
            pmtiles_path, tmp_dir
        )
        green_geoms_m = _load_green_geoms_m(base_pmtiles_path, tmp_dir)
        arterial_roads_m = _load_arterial_roads_m(roads_pmtiles_path, tmp_dir)

    buildings: list[dict[str, Any]] = []
    for bid, geom_deg, geom_m in zip(building_ids, building_geoms_deg, building_geoms_m):
        props = building_props[bid]
        rep_deg = geom_deg.representative_point()
        rep_m = geom_m.representative_point()
        buildings.append(
            {
                "id": bid,
                "name": props.get("name"),
                "bclass": props.get("bclass", "unknown"),
                "effective_height": props.get("effective_height"),
                "num_floors": props.get("num_floors"),
                "area_m2": props.get("area_m2"),
                "lon": float(rep_deg.x),
                "lat": float(rep_deg.y),
                "rep_pt_m": rep_m,
            }
        )

    print(
        f"Computing analytics for {len(barangays)} barangays across {len(buildings):,} buildings "
        f"({len(green_geoms_m)} green zones, {len(arterial_roads_m):,} arterial road segments)..."
    )
    citywide, barangay_rows = compute_barangay_metrics(
        barangays=barangays,
        buildings=buildings,
        building_pois=building_pois,
        green_geoms_m=green_geoms_m,
        dem_sampler=dem_sampler,
    )
    catchment_grid = build_catchment_grid(buildings, arterial_roads_m, cell_size_m=250.0)

    analytics_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "citywide": citywide,
        "barangays": barangay_rows,
    }
    tmp_analytics = out_analytics_path.with_suffix(".json.tmp")
    tmp_analytics.write_text(json.dumps(analytics_payload, separators=(",", ":")), encoding="utf-8")
    tmp_analytics.replace(out_analytics_path)

    tmp_catchment = out_catchment_path.with_suffix(".json.tmp")
    tmp_catchment.write_text(json.dumps(catchment_grid, separators=(",", ":")), encoding="utf-8")
    tmp_catchment.replace(out_catchment_path)

    # Enrich boundaries.geojson in-place with choropleth metrics
    by_name = {row["name"]: row for row in barangay_rows}
    choropleth_fields = (
        "area_km2",
        "building_count",
        "building_density_per_km2",
        "built_coverage_pct",
        "est_gfa_m2",
        "commercial_count",
        "commercial_share_pct",
        "poi_count",
        "poi_density_per_km2",
        "mean_elev_m",
        "low_lying_pct",
        "green_space_pct",
    )
    for feat in boundaries_fc.get("features", []):
        props = feat.get("properties") or {}
        if props.get("level") != "barangay":
            continue
        row = by_name.get(str(props.get("name")))
        if not row:
            continue
        for key in choropleth_fields:
            props[key] = row[key]

    tmp_bounds = boundaries_path.with_suffix(".geojson.tmp")
    tmp_bounds.write_text(json.dumps(boundaries_fc, separators=(",", ":")), encoding="utf-8")
    tmp_bounds.replace(boundaries_path)

    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = manifest.setdefault("files", {})
        files["barangay_analytics"] = f"{PLACE.data_url_dir}/barangay_analytics.json"
        files["catchment_grid"] = f"{PLACE.data_url_dir}/catchment_grid.json"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(
        f"Wrote {len(barangay_rows)} barangay records -> {out_analytics_path} "
        f"({out_analytics_path.stat().st_size / 1024:.1f} KB)"
    )
    print(
        f"Wrote {len(catchment_grid['cells']):,} 250m catchment cells -> {out_catchment_path} "
        f"({out_catchment_path.stat().st_size / 1024:.1f} KB)"
    )
    print(f"Enriched choropleth properties in {boundaries_path}")

    return {
        "citywide": citywide,
        "barangays": len(barangay_rows),
        "catchment_cells": len(catchment_grid["cells"]),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute per-barangay analytics and 250m catchment grid for one place."
    )
    from place import add_place_argument

    add_place_argument(parser)
    parser.add_argument("--pmtiles", type=Path, default=DEFAULT_BUILDINGS_PMTILES)
    parser.add_argument("--roads-pmtiles", type=Path, default=DEFAULT_ROADS_PMTILES)
    parser.add_argument("--base-pmtiles", type=Path, default=DEFAULT_BASE_PMTILES)
    parser.add_argument("--boundaries", type=Path, default=DEFAULT_BOUNDARIES)
    parser.add_argument("--building-pois", type=Path, default=DEFAULT_BUILDING_POIS)
    parser.add_argument("--dem-manifest", type=Path, default=DEFAULT_DEM_MANIFEST)
    parser.add_argument("--out-analytics", type=Path, default=DEFAULT_OUT_ANALYTICS)
    parser.add_argument("--out-catchment", type=Path, default=DEFAULT_OUT_CATCHMENT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    compute_and_write_analytics(
        pmtiles_path=args.pmtiles,
        roads_pmtiles_path=args.roads_pmtiles,
        base_pmtiles_path=args.base_pmtiles,
        boundaries_path=args.boundaries,
        building_pois_path=args.building_pois,
        dem_manifest_path=args.dem_manifest,
        out_analytics_path=args.out_analytics,
        out_catchment_path=args.out_catchment,
        manifest_path=args.manifest,
    )
    reapply_bir_zonal_fields(args.out_analytics, args.boundaries)
    return 0


def reapply_bir_zonal_fields(analytics_path: Path, boundaries_path: Path) -> None:
    """Re-merge BIR zonal fields, which this script's rewrite of both files would otherwise drop.

    Uses the already-parsed bir_zonal_values.json (from parse_bir_zonal_values.py), so the
    BIR workbook is not re-read here.
    """
    zonal_path = analytics_path.with_name("bir_zonal_values.json")
    if not zonal_path.exists():
        print(f"No {zonal_path.name}; skipping zonal fields (run parse_bir_zonal_values.py).")
        return
    try:
        from scripts.parse_bir_zonal_values import enrich_outputs
    except ImportError:
        from parse_bir_zonal_values import enrich_outputs  # type: ignore[no-redef]
    payload = json.loads(zonal_path.read_text(encoding="utf-8"))
    enrich_outputs(payload, analytics_path, boundaries_path)
    print(f"Re-applied BIR zonal fields from {zonal_path.name}.")


if __name__ == "__main__":
    sys.exit(main())
