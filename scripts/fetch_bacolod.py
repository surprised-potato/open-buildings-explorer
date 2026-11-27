#!/usr/bin/env python3
"""Fetch Bacolod City geospatial layers from Overture Maps 2026-11-18.0 and OSM Overpass,
compute 3D building heights, compile static PMTiles, and emit boundaries.geojson + manifest.json.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb
import requests
from shapely import clip_by_rect
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

OVERTURE_RELEASE = "2026-11-18.0"
S3_BASE = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"

# Full Bacolod City, Negros Occidental, Philippines bounding box & default center
WEST, SOUTH, EAST, NORTH = 122.89, 10.58, 123.14, 10.74
BBOX = [WEST, SOUTH, EAST, NORTH]
CENTER = [122.9509, 10.6765]

ROOT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT_DIR / "public" / "data" / "bacolod"

# Official 61 barangays of Bacolod City (41 numbered + 20 named)
BACOLOD_BARANGAYS: set[str] = {
    *(f"Barangay {i}" for i in range(1, 42)),
    "Alangilan",
    "Alijis",
    "Banago",
    "Bata",
    "Cabug",
    "Estefania",
    "Felisa",
    "Granada",
    "Handumanan",
    "Mandalagan",
    "Mansilingan",
    "Montevista",
    "Pahanocoy",
    "Punta Taytay",
    "Singcang-Airport",
    "Sum-ag",
    "Taculing",
    "Tangub",
    "Villamonte",
    "Vista Alegre",
}

RESIDENTIAL_CLASSES = {
    "residential",
    "house",
    "detached",
    "apartments",
    "semidetached_house",
    "terrace",
    "bungalow",
    "dormitory",
}

COMMERCIAL_CIVIC_CLASSES = {
    "commercial",
    "office",
    "retail",
    "civic",
    "public",
    "school",
    "college",
    "education",
    "hospital",
    "clinic",
    "healthcare",
    "government",
    "hotel",
    "university",
    "mixed_use",
}

INDUSTRIAL_CLASSES = {
    "industrial",
    "warehouse",
    "factory",
    "manufacture",
    "shed",
}

RELIGIOUS_CLASSES = {
    "religious",
    "church",
    "cathedral",
    "chapel",
    "mosque",
    "temple",
}

OVERPASS_ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def estimate_building_height(
    height: float | None,
    num_floors: int | float | None,
    bclass: str | None,
    area_m2: float | None,
) -> tuple[float, str]:
    """Apply the 3-tier height cascade matching src/utils/heightHeuristics.ts."""
    if height is not None and math.isfinite(height) and height > 0:
        return round(float(height), 1), "measured"

    if num_floors is not None and math.isfinite(num_floors) and num_floors > 0:
        return round(float(num_floors) * 3.2, 1), "floors"

    cls = (bclass or "unknown").lower().strip()
    area = float(area_m2) if area_m2 is not None and math.isfinite(area_m2) and area_m2 > 0 else 100.0

    if cls in RESIDENTIAL_CLASSES:
        h = 4.2 if area < 80 else (6.0 if area < 200 else 7.8)
        return h, "estimated"

    if cls in COMMERCIAL_CIVIC_CLASSES:
        scaled = 9.5 + math.log10(max(area, 50.0) / 50.0) * 3.0
        return round(min(14.0, max(9.5, scaled)), 1), "estimated"

    if cls in INDUSTRIAL_CLASSES:
        return 8.5, "estimated"

    if cls in RELIGIOUS_CLASSES:
        return 11.0, "estimated"

    fallback = 4.5 if area < 60 else (6.0 if area < 150 else (7.5 if area < 400 else 9.0))
    return fallback, "estimated"


def ensure_polygonal(geom_geojson_str: str | None, clip_bbox: bool = False) -> dict[str, Any] | None:
    """Validate and coerce GeoJSON geometry to a non-empty Polygon or MultiPolygon."""
    if not geom_geojson_str:
        return None
    try:
        geom = shape(json.loads(geom_geojson_str))
    except Exception:
        return None
    if geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if clip_bbox and not geom.is_empty:
        geom = clip_by_rect(geom, WEST, SOUTH, EAST, NORTH)
    if geom.is_empty:
        return None

    if isinstance(geom, (Polygon, MultiPolygon)):
        return mapping(geom)

    if hasattr(geom, "geoms"):
        polys = [g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty]
        if not polys:
            return None
        merged = unary_union(polys)
        if isinstance(merged, (Polygon, MultiPolygon)) and not merged.is_empty:
            return mapping(merged)
    return None


def ensure_linear(geom_geojson_str: str | None, clip_bbox: bool = True) -> dict[str, Any] | None:
    """Validate and clip GeoJSON line geometry to a non-empty LineString or MultiLineString."""
    if not geom_geojson_str:
        return None
    try:
        geom = shape(json.loads(geom_geojson_str))
    except Exception:
        return None
    if geom.is_empty:
        return None
    if clip_bbox:
        geom = clip_by_rect(geom, WEST, SOUTH, EAST, NORTH)
    if geom.is_empty:
        return None
    if isinstance(geom, (LineString, MultiLineString)):
        return mapping(geom)
    if hasattr(geom, "geoms"):
        lines = [g for g in geom.geoms if isinstance(g, (LineString, MultiLineString)) and not g.is_empty]
        if not lines:
            return None
        merged = unary_union(lines)
        if isinstance(merged, (LineString, MultiLineString)) and not merged.is_empty:
            return mapping(merged)
    return None


def compute_centroid_and_bbox(geom_dict: dict[str, Any]) -> tuple[float, float, list[float]]:
    """Return (centroid_lon, centroid_lat, [minLon, minLat, maxLon, maxLat])."""
    geom = shape(geom_dict)
    pt = geom.representative_point() if not geom.contains(geom.centroid) else geom.centroid
    minx, miny, maxx, maxy = geom.bounds
    return (
        round(float(pt.x), 6),
        round(float(pt.y), 6),
        [round(float(minx), 6), round(float(miny), 6), round(float(maxx), 6), round(float(maxy), 6)],
    )


def create_duckdb_connection() -> duckdb.DuckDBPyConnection:
    """Initialize DuckDB with spatial + httpfs extensions and anonymous Overture S3 access."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET geometry_always_xy = true;")
    con.execute("SET s3_region = 'us-west-2';")
    con.execute("SET s3_access_key_id = '';")
    con.execute("SET s3_secret_access_key = '';")
    return con


def run_ogr2ogr_pmtiles(
    input_path: Path,
    output_pmtiles: Path,
    layer_name: str,
    minzoom: int,
    maxzoom: int,
) -> None:
    """Compile a vector dataset into a single-layer PMTiles archive via ogr2ogr."""
    if output_pmtiles.exists():
        output_pmtiles.unlink()
    cmd = [
        "ogr2ogr",
        "-f",
        "PMTiles",
        "-nln",
        layer_name,
        "-dsco",
        f"MINZOOM={minzoom}",
        "-dsco",
        f"MAXZOOM={maxzoom}",
        "-t_srs",
        "EPSG:4326",
        str(output_pmtiles),
        str(input_path),
    ]
    print(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def bbox_where(alias: str = "") -> str:
    prefix = f"{alias}." if alias else ""
    return (
        f"{prefix}bbox.xmin <= {EAST} AND {prefix}bbox.xmax >= {WEST} "
        f"AND {prefix}bbox.ymin <= {NORTH} AND {prefix}bbox.ymax >= {SOUTH}"
    )


def fetch_buildings(con: duckdb.DuckDBPyConnection, tmp_dir: Path) -> dict[str, int]:
    """Extract Overture buildings + building_parts, apply height cascade, build PMTiles."""
    print("Fetching buildings and building_parts from Overture...")
    b_path = f"{S3_BASE}/theme=buildings/type=building/*.parquet"
    bp_path = f"{S3_BASE}/theme=buildings/type=building_part/*.parquet"

    query = f"""
    WITH raw_buildings AS (
        SELECT
            id,
            names.primary AS name,
            COALESCE(NULLIF(LOWER(TRIM(class)), ''), 'unknown') AS bclass,
            subtype,
            height,
            num_floors,
            COALESCE(min_height, 0.0) AS min_height,
            roof_shape,
            roof_color,
            facade_color,
            COALESCE(sources[1].dataset, 'Overture Maps') AS primary_source,
            COALESCE(has_parts, false) AS has_parts,
            CASE WHEN ST_IsValid(geometry) THEN geometry ELSE ST_MakeValid(geometry) END AS geom
        FROM read_parquet('{b_path}')
        WHERE {bbox_where()}
          AND geometry IS NOT NULL
    ),
    raw_parts AS (
        SELECT
            bp.id,
            COALESCE(bp.names.primary, b.names.primary) AS name,
            COALESCE(NULLIF(LOWER(TRIM(b.class)), ''), 'unknown') AS bclass,
            b.subtype,
            bp.height,
            bp.num_floors,
            COALESCE(bp.min_height, 0.0) AS min_height,
            COALESCE(bp.roof_shape, b.roof_shape) AS roof_shape,
            COALESCE(bp.roof_color, b.roof_color) AS roof_color,
            COALESCE(bp.facade_color, b.facade_color) AS facade_color,
            COALESCE(bp.sources[1].dataset, b.sources[1].dataset, 'Overture Maps') AS primary_source,
            bp.building_id,
            CASE WHEN ST_IsValid(bp.geometry) THEN bp.geometry ELSE ST_MakeValid(bp.geometry) END AS geom
        FROM read_parquet('{bp_path}') bp
        LEFT JOIN read_parquet('{b_path}') b
          ON bp.building_id = b.id AND {bbox_where('b')}
        WHERE {bbox_where('bp')}
          AND bp.geometry IS NOT NULL
    ),
    part_parents AS (
        SELECT DISTINCT building_id FROM raw_parts WHERE building_id IS NOT NULL
    ),
    combined AS (
        SELECT
            id, name, bclass, subtype, height, num_floors, min_height,
            roof_shape, roof_color, facade_color, primary_source, geom
        FROM raw_buildings
        WHERE NOT has_parts OR id NOT IN (SELECT building_id FROM part_parents)
        UNION ALL
        SELECT
            id, name, bclass, subtype, height, num_floors, min_height,
            roof_shape, roof_color, facade_color, primary_source, geom
        FROM raw_parts
    )
    SELECT
        id,
        name,
        bclass,
        subtype,
        height,
        num_floors,
        min_height,
        ROUND(ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:32651')), 2) AS area_m2,
        roof_shape,
        roof_color,
        facade_color,
        primary_source,
        ST_AsGeoJSON(geom) AS geom_json
    FROM combined
    WHERE geom IS NOT NULL
      AND NOT ST_IsEmpty(geom)
      AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')
    """

    rows = con.execute(query).fetchall()
    if not rows:
        raise RuntimeError("Overture query returned 0 buildings for Bacolod City bbox!")

    counts = {
        "buildings": 0,
        "buildings_measured": 0,
        "buildings_floors": 0,
        "buildings_estimated": 0,
    }

    geojsonl_path = tmp_dir / "buildings.geojsonl"
    with geojsonl_path.open("w", encoding="utf-8") as fh:
        for (
            fid,
            name,
            bclass,
            subtype,
            height,
            num_floors,
            min_height,
            area_m2,
            roof_shape,
            roof_color,
            facade_color,
            primary_source,
            geom_json,
        ) in rows:
            geom_dict = ensure_polygonal(geom_json)
            if geom_dict is None:
                continue

            area_val = round(float(area_m2 or 0.0), 2)
            eff_height, h_source = estimate_building_height(height, num_floors, bclass, area_val)
            min_h = round(float(min_height or 0.0), 1)
            if min_h >= eff_height:
                min_h = 0.0

            feature = {
                "type": "Feature",
                "geometry": geom_dict,
                "properties": {
                    "id": str(fid),
                    "name": name,
                    "bclass": bclass or "unknown",
                    "subtype": subtype,
                    "height": round(float(height), 2) if height is not None else None,
                    "num_floors": int(num_floors) if num_floors is not None else None,
                    "min_height": min_h,
                    "effective_height": eff_height,
                    "height_source": h_source,
                    "area_m2": area_val,
                    "roof_shape": roof_shape,
                    "roof_color": roof_color,
                    "facade_color": facade_color,
                    "primary_source": primary_source or "Overture Maps",
                },
            }
            fh.write(json.dumps(feature, separators=(",", ":")) + "\n")
            counts["buildings"] += 1
            counts[f"buildings_{h_source}"] += 1

    if counts["buildings"] == 0:
        raise RuntimeError("No valid Polygon/MultiPolygon building features produced!")

    run_ogr2ogr_pmtiles(
        geojsonl_path,
        OUT_DIR / "bacolod_buildings.pmtiles",
        layer_name="buildings",
        minzoom=11,
        maxzoom=16,
    )
    print(f"Buildings built: {counts}")
    return counts


def fetch_roads(con: duckdb.DuckDBPyConnection, tmp_dir: Path) -> int:
    """Extract Overture transportation segments and compile bacolod_roads.pmtiles."""
    print("Fetching roads from Overture...")
    r_path = f"{S3_BASE}/theme=transportation/type=segment/*.parquet"
    query = f"""
    SELECT
        id,
        names.primary AS name,
        COALESCE(NULLIF(LOWER(TRIM(class)), ''), 'unknown') AS rclass,
        subtype,
        ST_AsGeoJSON(geometry) AS geom_json
    FROM read_parquet('{r_path}')
    WHERE {bbox_where()}
      AND geometry IS NOT NULL
      AND NOT ST_IsEmpty(geometry)
    """
    rows = con.execute(query).fetchall()
    geojsonl_path = tmp_dir / "roads.geojsonl"
    count = 0
    with geojsonl_path.open("w", encoding="utf-8") as fh:
        for fid, name, rclass, subtype, geom_json in rows:
            geom_dict = ensure_linear(geom_json, clip_bbox=True)
            if geom_dict is None:
                continue
            feature = {
                "type": "Feature",
                "geometry": geom_dict,
                "properties": {
                    "id": str(fid),
                    "name": name,
                    "rclass": rclass or "unknown",
                    "subtype": subtype,
                },
            }
            fh.write(json.dumps(feature, separators=(",", ":")) + "\n")
            count += 1

    if count == 0:
        raise RuntimeError("Overture query returned 0 roads!")

    run_ogr2ogr_pmtiles(
        geojsonl_path,
        OUT_DIR / "bacolod_roads.pmtiles",
        layer_name="roads",
        minzoom=10,
        maxzoom=16,
    )
    print(f"Roads built: {count}")
    return count


def fetch_base(con: duckdb.DuckDBPyConnection, tmp_dir: Path) -> int:
    """Extract Overture base water & land_use polygons and compile bacolod_base.pmtiles."""
    print("Fetching water & land_use from Overture...")
    w_path = f"{S3_BASE}/theme=base/type=water/*.parquet"
    l_path = f"{S3_BASE}/theme=base/type=land_use/*.parquet"
    query = f"""
    WITH combined AS (
        SELECT
            id,
            'water' AS kind,
            COALESCE(NULLIF(LOWER(TRIM(class)), ''), COALESCE(subtype, 'water')) AS bclass,
            names.primary AS name,
            CASE WHEN ST_IsValid(geometry) THEN geometry ELSE ST_MakeValid(geometry) END AS geom
        FROM read_parquet('{w_path}')
        WHERE {bbox_where()}
          AND geometry IS NOT NULL
        UNION ALL
        SELECT
            id,
            'land_use' AS kind,
            COALESCE(NULLIF(LOWER(TRIM(class)), ''), COALESCE(subtype, 'land_use')) AS bclass,
            names.primary AS name,
            CASE WHEN ST_IsValid(geometry) THEN geometry ELSE ST_MakeValid(geometry) END AS geom
        FROM read_parquet('{l_path}')
        WHERE {bbox_where()}
          AND geometry IS NOT NULL
    )
    SELECT id, kind, bclass, name, ST_AsGeoJSON(geom) AS geom_json
    FROM combined
    WHERE geom IS NOT NULL
      AND NOT ST_IsEmpty(geom)
      AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')
    """
    rows = con.execute(query).fetchall()
    geojsonl_path = tmp_dir / "base.geojsonl"
    count = 0
    with geojsonl_path.open("w", encoding="utf-8") as fh:
        for fid, kind, bclass, name, geom_json in rows:
            geom_dict = ensure_polygonal(geom_json, clip_bbox=True)
            if geom_dict is None:
                continue
            feature = {
                "type": "Feature",
                "geometry": geom_dict,
                "properties": {
                    "id": str(fid),
                    "kind": kind,
                    "bclass": bclass or kind,
                    "name": name,
                },
            }
            fh.write(json.dumps(feature, separators=(",", ":")) + "\n")
            count += 1

    if count == 0:
        raise RuntimeError("Overture query returned 0 base features!")

    run_ogr2ogr_pmtiles(
        geojsonl_path,
        OUT_DIR / "bacolod_base.pmtiles",
        layer_name="base",
        minzoom=10,
        maxzoom=15,
    )
    print(f"Base features built: {count}")
    return count


def polygonize_osm_relation(rel: dict[str, Any]) -> dict[str, Any] | None:
    """Reconstruct Polygon/MultiPolygon from an Overpass `out geom` relation."""
    outer_lines = []
    inner_lines = []
    for member in rel.get("members", []):
        if member.get("type") != "way":
            continue
        coords = [(pt["lon"], pt["lat"]) for pt in member.get("geometry", []) if "lon" in pt and "lat" in pt]
        if len(coords) < 2:
            continue
        if member.get("role") == "inner":
            inner_lines.append(coords)
        else:
            outer_lines.append(coords)

    if not outer_lines:
        return None
    outer_polys = list(polygonize(outer_lines))
    if not outer_polys:
        return None
    geom = unary_union(outer_polys)
    if inner_lines:
        inner_polys = list(polygonize(inner_lines))
        if inner_polys:
            geom = geom.difference(unary_union(inner_polys))
    if not geom.is_valid:
        geom = make_valid(geom)
    if geom.is_empty:
        return None
    if not isinstance(geom, (Polygon, MultiPolygon)):
        return None
    return mapping(geom)


def fetch_overpass_boundaries() -> tuple[dict[str, Any] | None, dict[str, tuple[str, dict[str, Any]]]]:
    """Fetch Bacolod City (rel/11349321) + admin_level=10 barangay polygons from Overpass."""
    query = f"""[out:json][timeout:60];
(
  relation(11349321);
  relation["boundary"="administrative"]["admin_level"="10"]({SOUTH},{WEST},{NORTH},{EAST});
);
out geom;"""
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            resp = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": "BacolodDigitalTwin/1.0"},
                timeout=65,
            )
            if resp.status_code != 200:
                print(f"Overpass {endpoint} HTTP {resp.status_code}")
                continue
            data = resp.json()
            elements = data.get("elements", [])
            city_geom: dict[str, Any] | None = None
            barangays: dict[str, tuple[str, dict[str, Any]]] = {}
            for el in elements:
                if el.get("type") != "relation":
                    continue
                tags = el.get("tags", {})
                name = str(tags.get("name", "")).strip()
                geom_dict = polygonize_osm_relation(el)
                if geom_dict is None:
                    continue
                if el.get("id") == 11349321:
                    city_geom = geom_dict
                elif name in BACOLOD_BARANGAYS and name not in barangays:
                    barangays[name] = (f"osm-rel-{el['id']}", geom_dict)
            if barangays or city_geom:
                print(f"Overpass {endpoint} returned city={city_geom is not None}, barangays={len(barangays)}")
                return city_geom, barangays
        except Exception as exc:
            print(f"Overpass {endpoint} failed: {exc}")
    return None, {}


def fetch_boundaries(con: duckdb.DuckDBPyConnection) -> int:
    """Build boundaries.geojson combining Overture divisions + OSM Overpass so all 61 barangays exist."""
    print("Fetching Bacolod City & 61 barangay boundaries...")
    div_path = f"{S3_BASE}/theme=divisions/type=division/*.parquet"
    area_path = f"{S3_BASE}/theme=divisions/type=division_area/*.parquet"

    rows = con.execute(
        f"""
        SELECT
            d.id,
            d.names.primary AS name,
            d.subtype,
            d.parent_division_id,
            ST_Area(ST_Transform(a.geometry, 'EPSG:4326', 'EPSG:32651')) AS area_m2,
            ST_AsGeoJSON(a.geometry) AS geom_json
        FROM read_parquet('{div_path}') d
        JOIN read_parquet('{area_path}') a
          ON d.id = a.division_id
         AND a.country = 'PH'
         AND a.is_land = true
         AND {bbox_where('a')}
        WHERE {bbox_where('d')}
          AND d.country = 'PH'
          AND a.geometry IS NOT NULL
        """
    ).fetchall()

    city_feature: dict[str, Any] | None = None
    overture_barangays: dict[str, tuple[float, str, dict[str, Any]]] = {}

    for div_id, name, subtype, parent_id, area_m2, geom_json in rows:
        if not name or not geom_json:
            continue
        geom_dict = ensure_polygonal(geom_json)
        if geom_dict is None:
            continue
        area_val = float(area_m2 or 0.0)
        if name == "Bacolod" and subtype == "locality":
            city_feature = (str(div_id), geom_dict)
        elif name in BACOLOD_BARANGAYS:
            # Prefer larger official barangay polygon when duplicate neighborhood names exist (e.g. Cabug)
            prev = overture_barangays.get(name)
            if prev is None or area_val > prev[0]:
                overture_barangays[name] = (area_val, str(div_id), geom_dict)

    print(f"Overture divisions matched {len(overture_barangays)} of {len(BACOLOD_BARANGAYS)} barangays.")

    osm_city_geom, osm_barangays = fetch_overpass_boundaries()

    features: list[dict[str, Any]] = []

    if city_feature is not None:
        cid, cgeom = city_feature
    elif osm_city_geom is not None:
        cid, cgeom = "osm-rel-11349321", osm_city_geom
    else:
        raise RuntimeError("Could not obtain Bacolod City boundary from Overture or Overpass!")

    clon, clat, cbbox = compute_centroid_and_bbox(cgeom)
    features.append(
        {
            "type": "Feature",
            "geometry": cgeom,
            "properties": {
                "id": cid,
                "name": "Bacolod City",
                "level": "city",
                "centroid_lon": clon,
                "centroid_lat": clat,
                "bbox": cbbox,
            },
        }
    )

    missing_barangays: list[str] = []
    for brgy_name in sorted(BACOLOD_BARANGAYS):
        if brgy_name in overture_barangays:
            _, bid, bgeom = overture_barangays[brgy_name]
        elif brgy_name in osm_barangays:
            bid, bgeom = osm_barangays[brgy_name]
        else:
            missing_barangays.append(brgy_name)
            continue

        blon, blat, bbbox = compute_centroid_and_bbox(bgeom)
        features.append(
            {
                "type": "Feature",
                "geometry": bgeom,
                "properties": {
                    "id": bid,
                    "name": brgy_name,
                    "level": "barangay",
                    "centroid_lon": blon,
                    "centroid_lat": blat,
                    "bbox": bbbox,
                },
            }
        )

    if missing_barangays:
        print(f"WARNING: Missing barangays ({len(missing_barangays)}): {missing_barangays}")

    fc = {"type": "FeatureCollection", "features": features}
    out_path = OUT_DIR / "boundaries.geojson"
    out_path.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    barangay_count = len(features) - 1
    print(f"Boundaries built: 1 city + {barangay_count} barangays -> {out_path}")
    return barangay_count


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    con = create_duckdb_connection()

    with tempfile.TemporaryDirectory(prefix="bacolod_fetch_") as tmp:
        tmp_dir = Path(tmp)
        building_counts = fetch_buildings(con, tmp_dir)
        roads_count = fetch_roads(con, tmp_dir)
        base_count = fetch_base(con, tmp_dir)
        barangay_count = fetch_boundaries(con)

    manifest = {
        "city": "Bacolod City",
        "region": "Negros Occidental, Philippines",
        "overture_release": OVERTURE_RELEASE,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bbox": BBOX,
        "center": CENTER,
        "counts": {
            "buildings": building_counts["buildings"],
            "buildings_measured": building_counts["buildings_measured"],
            "buildings_floors": building_counts["buildings_floors"],
            "buildings_estimated": building_counts["buildings_estimated"],
            "roads": roads_count,
            "base_features": base_count,
            "barangays": barangay_count,
        },
        "files": {
            "buildings": "data/bacolod/bacolod_buildings.pmtiles",
            "roads": "data/bacolod/bacolod_roads.pmtiles",
            "base": "data/bacolod/bacolod_base.pmtiles",
            "boundaries": "data/bacolod/boundaries.geojson",
        },
    }
    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Manifest written to {manifest_path}")

    try:
        from scripts.enrich_osm_buildings import enrich_buildings_with_osm
    except ImportError:
        from enrich_osm_buildings import enrich_buildings_with_osm  # type: ignore[no-redef]

    enrich_buildings_with_osm(
        pmtiles_path=OUT_DIR / "bacolod_buildings.pmtiles",
        base_pmtiles_path=OUT_DIR / "bacolod_base.pmtiles",
        out_building_pois_path=OUT_DIR / "building_pois.json",
        out_labels_path=OUT_DIR / "building_labels.geojson",
        manifest_path=manifest_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
