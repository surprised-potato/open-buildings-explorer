#!/usr/bin/env python3
"""Fetch one place's geospatial layers (default Bacolod City) from Overture Maps 2026-11-18.0 and the
downloaded OSM snapshot, compute 3D building heights, compile static PMTiles, and emit boundaries.geojson +
manifest.json. The place comes from regions/negros-occidental.json (--place <slug> or PLACE).
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
from shapely import clip_by_rect
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

OVERTURE_RELEASE = "2026-11-18.0"
S3_BASE = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
OVERTURE_LOCAL = Path(__file__).resolve().parent.parent / "data" / "overture" / "negros-occidental"


def overture_path(theme: str, kind: str) -> str:
    """Province snapshot downloaded by extract_overture_region.py when present, else the S3 release."""
    local = OVERTURE_LOCAL / f"{theme}-{kind}.parquet"
    meta = OVERTURE_LOCAL / "meta.json"
    if local.exists() and meta.exists() and json.loads(meta.read_text()).get("release") == OVERTURE_RELEASE:
        return str(local)
    return f"{S3_BASE}/theme={theme}/type={kind}/*.parquet"

PLACE = current_place()

# Fetch extent (west, south, east, north) and default centre of the place
WEST, SOUTH, EAST, NORTH = PLACE.bbox
BBOX = [WEST, SOUTH, EAST, NORTH]
CENTER = list(PLACE.center)

ROOT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = PLACE.out_dir

# Official barangay names of the place (from the registry)
BARANGAYS: set[str] = set(PLACE.barangays)
BACOLOD_BARANGAYS = BARANGAYS  # old name, kept for imports

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


_PLACE_WKT: str | None = None


def place_filter(col: str) -> str:
    """SQL condition keeping features that touch the place outline (+~300 m), for places configured by
    configure_places.py ("boundary_mode": "fill"); Bacolod keeps its plain bbox queries."""
    global _PLACE_WKT
    if PLACE.setting("boundary_mode") != "fill":
        return ""
    if _PLACE_WKT is None:
        city, _ = fetch_osm_boundaries()
        if city is None:
            return ""
        _PLACE_WKT = make_valid(shape(city)).buffer(0.003).simplify(0.0005).wkt
    return f" AND ST_Intersects({col}, ST_GeomFromText('{_PLACE_WKT}'))"


def fetch_buildings(con: duckdb.DuckDBPyConnection, tmp_dir: Path) -> dict[str, int]:
    """Extract Overture buildings + building_parts, apply height cascade, build PMTiles."""
    print("Fetching buildings and building_parts from Overture...")
    b_path = overture_path("buildings", "building")
    bp_path = overture_path("buildings", "building_part")

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
      {place_filter('geom')}
    """

    rows = con.execute(query).fetchall()
    if not rows:
        raise RuntimeError(f"Overture query returned 0 buildings for the {PLACE.display_name} bbox!")

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
        PLACE.pmtiles("buildings"),
        layer_name="buildings",
        minzoom=11,
        maxzoom=16,
    )
    print(f"Buildings built: {counts}")
    return counts


def fetch_roads(con: duckdb.DuckDBPyConnection, tmp_dir: Path) -> int:
    """Extract Overture transportation segments and compile bacolod_roads.pmtiles."""
    print("Fetching roads from Overture...")
    r_path = overture_path("transportation", "segment")
    query = f"""
    SELECT
        id,
        names.primary AS name,
        COALESCE(NULLIF(LOWER(TRIM(class)), ''), 'unknown') AS rclass,
        subtype,
        ST_AsGeoJSON(geometry) AS geom_json
    FROM read_parquet('{r_path}')
    WHERE {bbox_where()}{place_filter('geometry')}
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
        PLACE.pmtiles("roads"),
        layer_name="roads",
        minzoom=10,
        maxzoom=16,
    )
    print(f"Roads built: {count}")
    return count


def fetch_base(con: duckdb.DuckDBPyConnection, tmp_dir: Path) -> int:
    """Extract Overture base water & land_use polygons and compile bacolod_base.pmtiles."""
    print("Fetching water & land_use from Overture...")
    w_path = overture_path("base", "water")
    l_path = overture_path("base", "land_use")
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
      AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON'){place_filter('geom')}
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
        PLACE.pmtiles("base"),
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


def fetch_osm_boundaries() -> tuple[dict[str, Any] | None, dict[str, tuple[str, dict[str, Any]]]]:
    """The place's OSM boundary relation + admin_level=10 barangay relations, from the downloaded OSM
    snapshot (extract_osm_region.py) rather than live Overpass. Used where Overture lacks a barangay."""
    from osm_snapshot import boundaries

    city_rel = int(PLACE.need("osm_relation"))
    city_geom: dict[str, Any] | None = None
    barangays: dict[str, tuple[str, dict[str, Any]]] = {}
    for feat in boundaries():
        props = feat["properties"]
        name = str(props.get("name", "")).strip()
        if props.get("osm_relation") == city_rel:
            city_geom = feat["geometry"]
            continue
        if props.get("admin_level") != 10 or name not in BARANGAYS or name in barangays:
            continue
        c = shape(feat["geometry"]).representative_point()
        if WEST <= c.x <= EAST and SOUTH <= c.y <= NORTH:
            barangays[name] = (f"osm-rel-{props['osm_relation']}", feat["geometry"])
    print(f"OSM snapshot boundaries: city={city_geom is not None}, barangays={len(barangays)}")
    return city_geom, barangays


def fetch_boundaries_filled(con: duckdb.DuckDBPyConnection) -> int:
    """Boundaries for places configured by configure_places.py (registry "boundary_mode": "fill").

    City outline: the OSM snapshot relation. Barangays (PSA names): an Overture division polygon or an OSM
    admin_level=10 polygon whose name matches (exact key or a close spelling) and lies inside the city;
    the rest get an approximate outline: the unclaimed land nearest to their Overture division point
    (Voronoi cells clipped to the city). Each barangay records its boundary_source.
    """
    from shapely import voronoi_polygons
    from shapely.geometry import MultiPoint, Point

    from names import best_match, match_key

    osm_city, _ = fetch_osm_boundaries()
    if osm_city is None:
        raise RuntimeError(f"OSM snapshot has no outline for relation {PLACE.need('osm_relation')}")
    city = make_valid(shape(osm_city)).buffer(0)
    inside = city.buffer(0.002)
    div_path, area_path = overture_path("divisions", "division"), overture_path("divisions", "division_area")
    areas: dict[str, tuple[float, str, Any]] = {}
    for did, name, geom_json in con.execute(
        f"""SELECT d.id, d.names.primary, ST_AsGeoJSON(a.geometry)
            FROM read_parquet('{div_path}') d JOIN read_parquet('{area_path}') a ON d.id = a.division_id
            WHERE d.country = 'PH' AND a.is_land = true AND {bbox_where('a')} AND a.geometry IS NOT NULL
              AND d.subtype NOT IN ('country', 'region', 'county')"""
    ).fetchall():
        g = make_valid(shape(json.loads(geom_json))).buffer(0)
        # Skip slivers (under ~0.5 ha): Overture has a few misplaced barangay polygons of that size.
        if name and not g.is_empty and inside.contains(g.representative_point()) and city.area * 0.9 > g.area > 4e-7:
            k = match_key(name)
            if k not in areas or g.area > areas[k][0]:
                areas[k] = (g.area, f"overture-{did}", g)
    points: dict[str, tuple[float, float]] = {}
    for name, lon, lat in con.execute(
        f"""SELECT names.primary, ST_X(geometry), ST_Y(geometry) FROM read_parquet('{div_path}')
            WHERE country = 'PH' AND {bbox_where()} AND ST_GeometryType(geometry) = 'POINT'
              AND subtype NOT IN ('country', 'region', 'county')"""
    ).fetchall():
        if name and inside.contains(Point(lon, lat)):
            points.setdefault(match_key(name), (lon, lat))
    from osm_snapshot import boundaries as osm_boundaries, load as osm_load

    try:  # OSM place=village/hamlet/... nodes fill names Overture lacks
        for el in osm_load("places.json")["elements"]:
            if inside.contains(Point(el["lon"], el["lat"])):
                points.setdefault(match_key(el["tags"]["name"]), (el["lon"], el["lat"]))
    except Exception:
        pass

    osm_polys = {}
    for f in osm_boundaries():
        if f["properties"].get("admin_level") == 10:
            g = make_valid(shape(f["geometry"])).buffer(0)
            if inside.contains(g.representative_point()):
                osm_polys[match_key(f["properties"]["name"])] = (f"osm-rel-{f['properties']['osm_relation']}", g)

    claimed = None
    out: dict[str, tuple[str, Any, str]] = {}
    seeds: dict[str, tuple[float, float]] = {}
    missing: list[str] = []
    for name in sorted(BARANGAYS):
        key = match_key(name)
        k_area = best_match(key, set(areas))
        k_osm = best_match(key, set(osm_polys))
        if k_area or k_osm:
            bid, g, src = (areas[k_area][1], areas[k_area][2], "overture") if k_area else (*osm_polys[k_osm], "osm")
            g = g.intersection(city)
            if claimed is not None:
                g = g.difference(claimed)
            if not g.is_empty and g.area > 0:
                out[name] = (bid, g, src)
                claimed = g if claimed is None else claimed.union(g)
                continue
        k_pt = best_match(key, set(points))
        if k_pt:
            seeds[name] = points[k_pt]
        else:
            missing.append(name)
    combined_name = f"{PLACE.name} town centre (combined)"
    if missing:
        # Barangays with no location anywhere (often small numbered poblacion barangays) share one zone
        # around the town centre, so their residents stay in the model.
        from names import lgu_key

        centre = None
        for name_, lon, lat in con.execute(
            f"""SELECT names.primary, ST_X(geometry), ST_Y(geometry) FROM read_parquet('{div_path}')
                WHERE country = 'PH' AND {bbox_where()} AND ST_GeometryType(geometry) = 'POINT' AND subtype = 'locality'"""
        ).fetchall():
            if name_ and lgu_key(name_) == lgu_key(PLACE.name) and city.contains(Point(lon, lat)):
                centre = (lon, lat)
                break
        if centre is None:
            c = city.representative_point()
            centre = (c.x, c.y)
        seeds[combined_name] = centre
    rest = city if claimed is None else city.difference(claimed)
    if seeds and not rest.is_empty:
        names = list(seeds)
        if len(names) == 1:
            cells = {names[0]: rest}
        else:
            vor = voronoi_polygons(MultiPoint([seeds[n] for n in names]), extend_to=city.envelope.buffer(0.1))
            cells = {}
            for cell in vor.geoms:
                for n in names:
                    if cell.contains(Point(seeds[n])):
                        cells[n] = cell.intersection(rest)
                        break
        for n, g in cells.items():
            if g.is_empty or g.area <= 0:
                if n != combined_name:
                    missing.append(n)
            elif n == combined_name:
                out[n] = ("approx-combined", g, "approximate (combined: no location for these barangays)")
            else:
                out[n] = (f"approx-{n}", g, "approximate (nearest land to the Overture or OSM point)")

    # Land still in no barangay (gaps between real outlines) joins the neighbour with the longest shared
    # border, so every part of the city belongs to a zone.
    covered = unary_union([g for _, g, _ in out.values()]) if out else None
    leftover = city if covered is None else city.difference(covered)
    pieces = [p for p in getattr(leftover, "geoms", [leftover]) if not p.is_empty and p.area > 1e-8]
    merged_into: dict[str, int] = {}
    for piece in pieces:
        if not out:
            break
        edge = piece.buffer(1e-5)
        best = max(out, key=lambda n: (edge.intersection(out[n][1]).area, -out[n][1].distance(piece)))
        bid, g, src = out[best]
        out[best] = (bid, unary_union([g, piece]), src)
        merged_into[best] = merged_into.get(best, 0) + 1
    for n in merged_into:
        bid, g, src = out[n]
        out[n] = (bid, g, src + " + unassigned land merged in")
    if merged_into:
        print(f"Merged {len(pieces)} unassigned piece(s) into {len(merged_into)} neighbouring barangay(s)")

    clon, clat, cbbox = compute_centroid_and_bbox(mapping(city))
    features: list[dict[str, Any]] = [{"type": "Feature", "geometry": mapping(city), "properties": {
        "id": f"osm-rel-{PLACE.need('osm_relation')}", "name": PLACE.display_name, "level": "city",
        "centroid_lon": clon, "centroid_lat": clat, "bbox": cbbox}}]
    geoms: dict[str, dict[str, Any]] = {}
    for name in sorted(out):
        gd = ensure_polygonal(json.dumps(mapping(out[name][1])))
        if gd is None:
            missing.append(name)
        else:
            geoms[name] = gd
    # Every PSA barangay must end up in some zone: whatever is still unplaced joins the combined zone, or,
    # when the town has none, the zone at the town centre (its members then list both).
    members: dict[str, list[str]] = {}
    placed = set(geoms) - {combined_name}
    leftover_names = sorted(n for n in BARANGAYS if n not in placed)
    if leftover_names and geoms:
        if combined_name in geoms:
            members[combined_name] = leftover_names
        else:
            cpt = Point(*seeds.get(combined_name, (city.representative_point().x, city.representative_point().y)))
            host = min(geoms, key=lambda n: shape(geoms[n]).distance(cpt))
            members[host] = [host, *leftover_names]
    for name, gd in geoms.items():
        bid, _, src = out[name]
        blon, blat, bbbox = compute_centroid_and_bbox(gd)
        props_ = {"id": bid, "name": name, "level": "barangay", "boundary_source": src,
                  "centroid_lon": blon, "centroid_lat": blat, "bbox": bbbox}
        if name in members:
            props_["members"] = members[name]
            if name != combined_name:
                props_["boundary_source"] = src + "; also holds barangays with no location"
        features.append({"type": "Feature", "geometry": gd, "properties": props_})
    missing = leftover_names
    counts: dict[str, int] = {}
    for _, _, src in out.values():
        counts[src.split(" ")[0]] = counts.get(src.split(" ")[0], 0) + 1
    print(f"Barangay outlines: {counts}; combined into the town-centre zone {len(missing)}: {missing}")
    out_path = OUT_DIR / "boundaries.geojson"
    out_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")), encoding="utf-8")
    print(f"Boundaries built: 1 city + {len(features) - 1} barangays -> {out_path}")
    return len(features) - 1


def fetch_boundaries(con: duckdb.DuckDBPyConnection) -> int:
    """Build boundaries.geojson combining Overture divisions + the OSM snapshot so every barangay exists."""
    if PLACE.setting("boundary_mode") == "fill":
        return fetch_boundaries_filled(con)
    print(f"Fetching {PLACE.display_name} & {len(BARANGAYS)} barangay boundaries...")
    div_path = overture_path("divisions", "division")
    area_path = overture_path("divisions", "division_area")

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
        if name == PLACE.setting("overture_locality", PLACE.name) and subtype == "locality":
            city_feature = (str(div_id), geom_dict)
        elif name in BARANGAYS:
            # Prefer larger official barangay polygon when duplicate neighborhood names exist (e.g. Cabug)
            prev = overture_barangays.get(name)
            if prev is None or area_val > prev[0]:
                overture_barangays[name] = (area_val, str(div_id), geom_dict)

    print(f"Overture divisions matched {len(overture_barangays)} of {len(BARANGAYS)} barangays.")

    osm_city_geom, osm_barangays = fetch_osm_boundaries()

    features: list[dict[str, Any]] = []

    if city_feature is not None:
        cid, cgeom = city_feature
    elif osm_city_geom is not None:
        cid, cgeom = f"osm-rel-{PLACE.need('osm_relation')}", osm_city_geom
    else:
        raise RuntimeError(f"Could not obtain the {PLACE.display_name} boundary from Overture or the OSM snapshot!")

    clon, clat, cbbox = compute_centroid_and_bbox(cgeom)
    features.append(
        {
            "type": "Feature",
            "geometry": cgeom,
            "properties": {
                "id": cid,
                "name": PLACE.display_name,
                "level": "city",
                "centroid_lon": clon,
                "centroid_lat": clat,
                "bbox": cbbox,
            },
        }
    )

    missing_barangays: list[str] = []
    for brgy_name in sorted(BARANGAYS):
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
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--no-enrich", action="store_true", help="skip the POI matching (the pipeline's osm stage runs it)")
    args = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    con = create_duckdb_connection()

    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_fetch_") as tmp:
        tmp_dir = Path(tmp)
        building_counts = fetch_buildings(con, tmp_dir)
        roads_count = fetch_roads(con, tmp_dir)
        base_count = fetch_base(con, tmp_dir)
        barangay_count = fetch_boundaries(con)

    manifest = {
        "city": PLACE.display_name,
        "region": f"{PLACE.province_display}, Philippines",
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
            "buildings": f"{PLACE.data_url_dir}/{PLACE.file_prefix}_buildings.pmtiles",
            "roads": f"{PLACE.data_url_dir}/{PLACE.file_prefix}_roads.pmtiles",
            "base": f"{PLACE.data_url_dir}/{PLACE.file_prefix}_base.pmtiles",
            "boundaries": f"{PLACE.data_url_dir}/boundaries.geojson",
        },
    }
    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Manifest written to {manifest_path}")

    if args.no_enrich:
        return 0
    try:
        from scripts.enrich_osm_buildings import enrich_buildings_with_osm
    except ImportError:
        from enrich_osm_buildings import enrich_buildings_with_osm  # type: ignore[no-redef]

    enrich_buildings_with_osm(
        pmtiles_path=PLACE.pmtiles("buildings"),
        base_pmtiles_path=PLACE.pmtiles("base"),
        out_building_pois_path=OUT_DIR / "building_pois.json",
        out_labels_path=OUT_DIR / "building_labels.geojson",
        manifest_path=manifest_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
