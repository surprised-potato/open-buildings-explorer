#!/usr/bin/env python3
"""Match OpenStreetMap (OSM) POI pins for one place (default Bacolod City), read from the downloaded OSM snapshot,
run a spatial containment + nearest-building matching algorithm against
building footprints, reclassify buildings (OSM POIs + Overture + OSM land use
with dedicated mixed_use support), update estimated heights, emit
public/data/bacolod/building_pois.json + building_labels.geojson, and
rebuild public/data/bacolod/bacolod_buildings.pmtiles + manifest.json.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from shapely import make_valid
from shapely import transform as shapely_transform
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

try:
    from scripts.fetch_bacolod import (
        EAST,
        NORTH,
        OUT_DIR,
        PLACE,
        SOUTH,
        WEST,
        estimate_building_height,
    )
except ImportError:
    from fetch_bacolod import (  # type: ignore[no-redef]
        EAST,
        NORTH,
        OUT_DIR,
        PLACE,
        SOUTH,
        WEST,
        estimate_building_height,
    )

DEFAULT_BUILDINGS_PMTILES = PLACE.pmtiles("buildings")
DEFAULT_ROADS_PMTILES = PLACE.pmtiles("roads")
DEFAULT_BASE_PMTILES = PLACE.pmtiles("base")
DEFAULT_BOUNDARIES = OUT_DIR / "boundaries.geojson"
DEFAULT_OUT_BUILDING_POIS = OUT_DIR / "building_pois.json"
DEFAULT_OUT_LABELS = OUT_DIR / "building_labels.geojson"
DEFAULT_MANIFEST = OUT_DIR / "manifest.json"

MAX_COMPOUND_AREA_M2 = 25_000_000.0
THIRD_PARTY_NEAREST_MAX_DIST_M = 14.0
THIRD_PARTY_NEAREST_MIN_CONFIDENCE = 0.75
OVERTURE_MIN_UPDATE_YEAR = 2024

COMPOUND_AMENITY_MAP: dict[str, str] = {
    "school": "school",
    "kindergarten": "school",
    "college": "college",
    "university": "university",
    "hospital": "hospital",
    "clinic": "healthcare",
    "place_of_worship": "religious",
    "marketplace": "retail",
    "townhall": "government",
    "courthouse": "government",
    "police": "government",
    "fire_station": "government",
    "bus_station": "civic",
    "ferry_terminal": "civic",
}

COMPOUND_SHOP_MAP: dict[str, str] = {
    "mall": "retail",
    "supermarket": "retail",
    "department_store": "retail",
}

# Local planar approximation in meters centred on the place (Bacolod: its historic 10.67°N)
CENTER_LAT = PLACE.planar_lat
M_PER_DEG_LAT = 111320.0
M_PER_DEG_LON = 111320.0 * math.cos(math.radians(CENTER_LAT))

RETAIL_SHOP_VALUES = {
    "mall",
    "supermarket",
    "department_store",
    "convenience",
    "bakery",
    "clothes",
    "hardware",
    "electronics",
    "variety_store",
    "greengrocer",
    "butcher",
    "shoes",
    "furniture",
    "books",
    "gift",
    "jewelry",
    "mobile_phone",
    "optician",
    "pet",
    "sports",
    "toys",
    "doityourself",
    "general",
    "kiosk",
    "beauty",
    "cosmetics",
    "alcohol",
    "beverages",
    "pastry",
    "seafood",
    "tea",
    "coffee",
    "florist",
    "stationery",
    "bicycle",
    "motorcycle",
    "car_parts",
    "tyres",
    "computer",
    "appliance",
    "fabric",
    "tailor",
    "second_hand",
    "wholesale",
}

COMMERCIAL_AMENITY_FOOD = {
    "restaurant",
    "fast_food",
    "cafe",
    "bar",
    "pub",
    "food_court",
    "ice_cream",
    "biergarten",
    "nightclub",
}

COMMERCIAL_AMENITY_SERVICE = {
    "bank",
    "bureau_de_change",
    "money_transfer",
    "fuel",
    "marketplace",
    "car_wash",
    "car_rental",
    "cinema",
    "theatre",
    "casino",
    "gambling",
    "events_venue",
    "conference_centre",
    "internet_cafe",
    "studio",
    "veterinary",
    "driving_school",
    "language_school",
    "music_school",
    "prep_school",
    "vehicle_inspection",
    "coworking_space",
    "brothel",
    "payment_centre",
}

NON_BUILDING_AMENITIES = {
    "parking",
    "parking_space",
    "parking_entrance",
    "bicycle_parking",
    "motorcycle_parking",
    "bench",
    "fountain",
    "waste_basket",
    "waste_disposal",
    "recycling",
    "toilets",
    "drinking_water",
    "shelter",
    "atm",
    "vending_machine",
    "post_box",
    "telephone",
    "clock",
    "bbq",
    "taxi",
    "loading_dock",
    "security_booth",
    "grave_yard",
    "watering_place",
    "compressed_air",
}

UNNAMED_MICRO_AMENITIES = {
    "bench",
    "waste_basket",
    "waste_disposal",
    "recycling",
    "parking_space",
    "parking_entrance",
    "toilets",
    "shelter",
    "security_booth",
    "drinking_water",
    "post_box",
    "bicycle_parking",
    "motorcycle_parking",
    "vending_machine",
    "telephone",
    "clock",
    "bbq",
    "loading_dock",
    "watering_place",
    "compressed_air",
}

INDOOR_LEISURE = {
    "fitness_centre",
    "sports_centre",
    "bowling_alley",
    "amusement_arcade",
    "dance",
    "escape_game",
    "sauna",
    "stadium",
    "indoor_play",
    "adult_gaming_centre",
}

OUTDOOR_LEISURE = {
    "park",
    "pitch",
    "playground",
    "garden",
    "swimming_pool",
    "track",
    "golf_course",
    "marina",
    "nature_reserve",
    "recreation_ground",
    "dog_park",
    "bleachers",
    "resort",
    "water_park",
}

INDUSTRIAL_CRAFTS = {
    "metal_construction",
    "sawmill",
    "welder",
    "blacksmith",
    "carpenter",
    "builder",
}

HOTEL_TOURISM = {
    "hotel",
    "motel",
    "resort",
    "hostel",
    "guest_house",
    "apartment",
    "chalet",
}

CIVIC_TOURISM = {
    "museum",
    "gallery",
    "theme_park",
    "aquarium",
    "zoo",
}

OUTDOOR_TOURISM = {
    "attraction",
    "artwork",
    "viewpoint",
    "picnic_site",
    "camp_site",
    "information",
    "monument",
}

EXPLICIT_BUILDING_TAGS = {
    "commercial",
    "retail",
    "office",
    "hotel",
    "industrial",
    "warehouse",
    "school",
    "college",
    "university",
    "hospital",
    "church",
    "cathedral",
    "chapel",
    "civic",
    "public",
    "government",
    "apartments",
    "supermarket",
}

LANDUSE_CLASS_MAP: dict[str, str] = {
    "commercial": "commercial",
    "retail": "retail",
    "industrial": "industrial",
    "residential": "residential",
    "school": "school",
    "college": "college",
    "university": "university",
    "hospital": "hospital",
    "religious": "religious",
    "resort": "hotel",
}

GENERIC_CLASSES = {
    "unknown",
    "yes",
    "building",
    "part",
    "roof",
    "shed",
    "carport",
    "guardhouse",
    "outbuilding",
    "",
}

RESIDENTIAL_OVERRIDABLE = {
    "house",
    "residential",
    "detached",
    "semidetached_house",
    "terrace",
    "bungalow",
}

COMMERCIAL_CLASSES = {"commercial", "retail", "office", "hotel", "resort", "mixed_use"}

USE_GROUPS: dict[str, set[str]] = {
    "residential": {
        "residential",
        "house",
        "detached",
        "semidetached_house",
        "terrace",
        "bungalow",
        "apartments",
        "dormitory",
    },
    "commercial_retail": {"commercial", "retail"},
    "office": {"office"},
    "hospitality": {"hotel", "resort"},
    "civic_edu": {"civic", "public", "government", "school", "college", "university"},
    "healthcare": {"hospital", "healthcare", "clinic"},
    "industrial": {"industrial", "warehouse", "factory", "manufacture"},
    "religious": {"religious", "church", "cathedral", "chapel", "mosque", "temple"},
}

CLASS_TO_USE_GROUP: dict[str, str] = {
    cls: grp for grp, classes in USE_GROUPS.items() for cls in classes
}

INSTITUTIONAL_ANCHORS = {
    "school",
    "college",
    "university",
    "hospital",
    "religious",
    "church",
    "cathedral",
    "chapel",
    "mosque",
    "temple",
    "government",
}


def _scale_coords_to_meters(coords: np.ndarray) -> np.ndarray:
    """Scale lon/lat coordinate array to local planar meters."""
    out = coords.copy()
    out[:, 0] *= M_PER_DEG_LON
    out[:, 1] *= M_PER_DEG_LAT
    return out


def geom_to_meters(geom: Any) -> Any:
    """Project a Shapely geometry from EPSG:4326 degrees to local Bacolod meters."""
    return shapely_transform(geom, _scale_coords_to_meters)


def coerce_polygonal(geom: Any) -> Polygon | MultiPolygon | None:
    """Ensure geometry is valid and polygonal (Polygon or MultiPolygon)."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if geom.is_empty:
        return None
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    if hasattr(geom, "geoms"):
        polys = [
            g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty
        ]
        if not polys:
            return None
        merged = unary_union(polys)
        if isinstance(merged, (Polygon, MultiPolygon)) and not merged.is_empty:
            return merged
    return None


def fetch_osm_pois() -> list[dict[str, Any]]:
    """OSM POI nodes and ways inside the place bbox, from the downloaded snapshot (no live Overpass).

    Same selection the Overpass query made: nw["shop"|"amenity"|"office"|"tourism"|"healthcare"|"craft"|
    "leisure"|"industrial"](bbox); out tags center.
    """
    from osm_snapshot import elements, source_label

    found = elements("osm_pois.json", (WEST, SOUTH, EAST, NORTH))
    print(f"{len(found):,} OSM POI elements from {source_label()}.")
    return found


def fetch_osm_compounds() -> list[dict[str, Any]]:
    """Campus / compound / land-use outlines inside the place bbox, from the downloaded snapshot.

    Same selection the Overpass query made: wr[amenity~school|university|...|ferry_terminal],
    wr[shop~mall|supermarket|department_store], wr[tourism=resort], wr[landuse~commercial|...|religious];
    out tags geom.
    """
    from osm_snapshot import elements

    found = elements("osm_compounds.json", (WEST, SOUTH, EAST, NORTH))
    print(f"{len(found):,} OSM compound / land-use elements from the snapshot.")
    return found


def _coords_from_overpass_geom(geom_pts: list[dict[str, Any]]) -> list[tuple[float, float]]:
    coords: list[tuple[float, float]] = []
    for pt in geom_pts:
        lon = pt.get("lon")
        lat = pt.get("lat")
        if lon is None or lat is None:
            continue
        coords.append((float(lon), float(lat)))
    return coords


def parse_osm_compounds(
    elements: list[dict[str, Any]],
) -> tuple[list[tuple[float, str, Any]], list[tuple[float, str, Any]]]:
    """Parse Overpass `out tags geom;` elements into (compound_items, extra_landuse_items)."""
    compound_items: list[tuple[float, str, Any]] = []
    extra_landuse_items: list[tuple[float, str, Any]] = []
    seen: set[tuple[str, int | str]] = set()

    extra_lu_map = {
        **LANDUSE_CLASS_MAP,
        "institutional": "civic",
        "education": "school",
        "religious": "religious",
    }

    for el in elements:
        el_type = str(el.get("type") or "")
        el_id = el.get("id")
        if el_type not in {"way", "relation"} or el_id is None:
            continue
        key = (el_type, el_id)
        if key in seen:
            continue
        seen.add(key)

        tags = el.get("tags") or {}
        if not isinstance(tags, dict):
            continue

        amenity = str(tags.get("amenity") or "").lower().strip()
        shop = str(tags.get("shop") or "").lower().strip()
        tourism = str(tags.get("tourism") or "").lower().strip()
        landuse = str(tags.get("landuse") or "").lower().strip()

        is_compound = False
        target_bclass: str | None = None
        if amenity in COMPOUND_AMENITY_MAP:
            target_bclass = COMPOUND_AMENITY_MAP[amenity]
            is_compound = True
        elif shop in COMPOUND_SHOP_MAP:
            target_bclass = COMPOUND_SHOP_MAP[shop]
            is_compound = True
        elif tourism == "resort":
            target_bclass = "hotel"
            is_compound = True
        elif landuse in extra_lu_map:
            target_bclass = extra_lu_map[landuse]
            is_compound = False

        if not target_bclass:
            continue

        poly_deg: Polygon | MultiPolygon | None = None
        if el_type == "way":
            coords = _coords_from_overpass_geom(el.get("geometry") or [])
            if len(coords) >= 4 and coords[0] == coords[-1]:
                poly_deg = coerce_polygonal(Polygon(coords))
        elif el_type == "relation":
            outer_lines: list[LineString] = []
            for member in el.get("members") or []:
                if member.get("type") != "way":
                    continue
                role = str(member.get("role") or "outer")
                if role not in {"", "outer"}:
                    continue
                coords = _coords_from_overpass_geom(member.get("geometry") or [])
                if len(coords) >= 2:
                    outer_lines.append(LineString(coords))
            if outer_lines:
                rings = list(polygonize(outer_lines))
                if rings:
                    poly_deg = coerce_polygonal(unary_union(rings))

        if poly_deg is None:
            continue

        poly_m = geom_to_meters(poly_deg)
        area_m2 = float(poly_m.area)
        if area_m2 < 25.0 or area_m2 > MAX_COMPOUND_AREA_M2:
            continue

        item = (area_m2, target_bclass, poly_m)
        if is_compound:
            compound_items.append(item)
        else:
            extra_landuse_items.append(item)

    compound_items.sort(key=lambda x: x[0])
    extra_landuse_items.sort(key=lambda x: x[0])
    return compound_items, extra_landuse_items


def _classify_single_tag(key: str, raw_val: str) -> dict[str, Any] | None:
    """Classify a single (key, value) OSM tag into POI category + building class."""
    val = raw_val.strip().lower()
    if not val or val in {"no", "none"}:
        return None

    if key == "shop":
        is_retail = val in RETAIL_SHOP_VALUES
        mapped = "retail" if is_retail else "commercial"
        cat = "retail" if is_retail else "commercial"
        priority = 100 if val in {"mall", "department_store", "supermarket"} else 90
        return {
            "poi_key": "shop",
            "poi_value": val,
            "category": cat,
            "mapped_bclass": mapped,
            "building_applicable": True,
            "priority": priority,
        }

    if key == "office":
        if val in {"government", "administrative", "diplomatic"}:
            return {
                "poi_key": "office",
                "poi_value": val,
                "category": "civic",
                "mapped_bclass": "government",
                "building_applicable": True,
                "priority": 95,
            }
        return {
            "poi_key": "office",
            "poi_value": val,
            "category": "office",
            "mapped_bclass": "office",
            "building_applicable": True,
            "priority": 85,
        }

    if key == "tourism":
        if val in HOTEL_TOURISM:
            return {
                "poi_key": "tourism",
                "poi_value": val,
                "category": "hotel",
                "mapped_bclass": "hotel",
                "building_applicable": True,
                "priority": 92,
            }
        if val in CIVIC_TOURISM:
            return {
                "poi_key": "tourism",
                "poi_value": val,
                "category": "civic",
                "mapped_bclass": "civic",
                "building_applicable": True,
                "priority": 80,
            }
        if val in OUTDOOR_TOURISM:
            return {
                "poi_key": "tourism",
                "poi_value": val,
                "category": "leisure",
                "mapped_bclass": None,
                "building_applicable": False,
                "priority": 30,
            }
        return {
            "poi_key": "tourism",
            "poi_value": val,
            "category": "leisure",
            "mapped_bclass": None,
            "building_applicable": False,
            "priority": 30,
        }

    if key == "healthcare":
        if val == "hospital":
            return {
                "poi_key": "healthcare",
                "poi_value": val,
                "category": "healthcare",
                "mapped_bclass": "hospital",
                "building_applicable": True,
                "priority": 100,
            }
        return {
            "poi_key": "healthcare",
            "poi_value": val,
            "category": "healthcare",
            "mapped_bclass": "healthcare",
            "building_applicable": True,
            "priority": 90,
        }

    if key == "amenity":
        if val in COMMERCIAL_AMENITY_FOOD:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "food",
                "mapped_bclass": "commercial",
                "building_applicable": True,
                "priority": 85,
            }
        if val in COMMERCIAL_AMENITY_SERVICE:
            mapped = "retail" if val == "marketplace" else "commercial"
            priority = 95 if val in {"marketplace", "cinema", "bank", "fuel"} else 85
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "commercial",
                "mapped_bclass": mapped,
                "building_applicable": True,
                "priority": priority,
            }
        if val == "pharmacy":
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "healthcare",
                "mapped_bclass": "retail",
                "building_applicable": True,
                "priority": 88,
            }
        if val == "hospital":
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "healthcare",
                "mapped_bclass": "hospital",
                "building_applicable": True,
                "priority": 100,
            }
        if val in {"clinic", "doctors", "dentist", "health_post", "nursing_home", "social_facility"}:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "healthcare",
                "mapped_bclass": "healthcare",
                "building_applicable": True,
                "priority": 90,
            }
        if val in {"school", "kindergarten"}:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "education",
                "mapped_bclass": "school",
                "building_applicable": True,
                "priority": 95,
            }
        if val == "college":
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "education",
                "mapped_bclass": "college",
                "building_applicable": True,
                "priority": 95,
            }
        if val == "university":
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "education",
                "mapped_bclass": "university",
                "building_applicable": True,
                "priority": 98,
            }
        if val in {
            "townhall",
            "courthouse",
            "police",
            "fire_station",
            "post_office",
            "public_building",
            "embassy",
            "prison",
            "ranger_station",
            "customs",
        }:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "civic",
                "mapped_bclass": "government",
                "building_applicable": True,
                "priority": 95,
            }
        if val in {
            "community_centre",
            "library",
            "arts_centre",
            "bus_station",
            "ferry_terminal",
            "terminal",
            "social_centre",
            "exhibition_centre",
        }:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "civic",
                "mapped_bclass": "civic",
                "building_applicable": True,
                "priority": 90,
            }
        if val in {"place_of_worship", "monastery", "convent"}:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "religious",
                "mapped_bclass": "religious",
                "building_applicable": True,
                "priority": 95,
            }
        if val in NON_BUILDING_AMENITIES:
            return {
                "poi_key": "amenity",
                "poi_value": val,
                "category": "other",
                "mapped_bclass": None,
                "building_applicable": False,
                "priority": 10,
            }
        return {
            "poi_key": "amenity",
            "poi_value": val,
            "category": "other",
            "mapped_bclass": None,
            "building_applicable": False,
            "priority": 15,
        }

    if key == "craft":
        is_ind = val in INDUSTRIAL_CRAFTS
        return {
            "poi_key": "craft",
            "poi_value": val,
            "category": "industrial" if is_ind else "commercial",
            "mapped_bclass": "industrial" if is_ind else "commercial",
            "building_applicable": True,
            "priority": 80,
        }

    if key == "industrial":
        return {
            "poi_key": "industrial",
            "poi_value": val,
            "category": "industrial",
            "mapped_bclass": "industrial",
            "building_applicable": True,
            "priority": 90,
        }

    if key == "leisure":
        if val in INDOOR_LEISURE:
            mapped = "civic" if val in {"stadium", "sports_centre"} else "commercial"
            return {
                "poi_key": "leisure",
                "poi_value": val,
                "category": "leisure",
                "mapped_bclass": mapped,
                "building_applicable": True,
                "priority": 80,
            }
        if val == "resort":
            return {
                "poi_key": "leisure",
                "poi_value": val,
                "category": "hotel",
                "mapped_bclass": "hotel",
                "building_applicable": True,
                "priority": 88,
            }
        if val in OUTDOOR_LEISURE:
            return {
                "poi_key": "leisure",
                "poi_value": val,
                "category": "leisure",
                "mapped_bclass": None,
                "building_applicable": False,
                "priority": 25,
            }
        return {
            "poi_key": "leisure",
            "poi_value": val,
            "category": "leisure",
            "mapped_bclass": None,
            "building_applicable": False,
            "priority": 25,
        }

    if key == "building" and val in EXPLICIT_BUILDING_TAGS:
        mapped = "retail" if val == "supermarket" else val
        cat = "commercial" if mapped in {"commercial", "retail", "office", "hotel"} else mapped
        return {
            "poi_key": "building",
            "poi_value": val,
            "category": cat,
            "mapped_bclass": mapped,
            "building_applicable": True,
            "priority": 60,
        }

    return None


def classify_osm_tags(tags: dict[str, Any]) -> dict[str, Any] | None:
    """Determine canonical POI classification and building target class from OSM tags."""
    candidates: list[dict[str, Any]] = []
    for key in (
        "healthcare",
        "tourism",
        "office",
        "shop",
        "amenity",
        "industrial",
        "craft",
        "leisure",
        "building",
    ):
        raw = tags.get(key)
        if isinstance(raw, str) and raw.strip():
            res = _classify_single_tag(key, raw)
            if res is not None:
                candidates.append(res)

    if not candidates:
        return None

    # Prefer building-applicable and highest priority
    candidates.sort(
        key=lambda c: (1 if c["building_applicable"] else 0, c["priority"]),
        reverse=True,
    )
    return candidates[0]


def normalize_osm_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate raw Overpass elements, extract coordinates, classify tags, and filter noise."""
    seen: set[tuple[str, int | str]] = set()
    pois: list[dict[str, Any]] = []

    for el in elements:
        el_type = str(el.get("type", ""))
        el_id = el.get("id")
        if not el_type or el_id is None:
            continue
        dedup_key = (el_type, el_id)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        if el_type == "node":
            lon = el.get("lon")
            lat = el.get("lat")
        else:
            center = el.get("center") or {}
            lon = center.get("lon")
            lat = center.get("lat")

        if lon is None or lat is None:
            continue
        try:
            lon_f = float(lon)
            lat_f = float(lat)
        except (TypeError, ValueError):
            continue

        tags = el.get("tags") or {}
        if not isinstance(tags, dict):
            continue

        classified = classify_osm_tags(tags)
        if classified is None:
            continue

        name = str(tags.get("name") or "").strip() or None

        # Filter out unnamed micro street furniture / unnamed outdoor pitches
        if name is None and not classified["building_applicable"]:
            if classified["poi_key"] == "amenity" and classified["poi_value"] in UNNAMED_MICRO_AMENITIES:
                continue
            if classified["poi_key"] == "leisure":
                continue

        poi: dict[str, Any] = {
            "osm_id": f"{el_type}/{el_id}",
            "osm_type": el_type,
            "source": "osm",
            "confidence": 1.0,
            "name": name,
            "lon": round(lon_f, 7),
            "lat": round(lat_f, 7),
            "poi_key": classified["poi_key"],
            "poi_value": classified["poi_value"],
            "category": classified["category"],
            "mapped_bclass": classified["mapped_bclass"],
            "building_applicable": classified["building_applicable"],
            "priority": classified["priority"],
            "brand": str(tags.get("brand") or "").strip() or None,
            "cuisine": str(tags.get("cuisine") or "").strip() or None,
            "addr_street": str(tags.get("addr:street") or "").strip() or None,
            "website": str(tags.get("website") or "").strip() or None,
            "phone": str(tags.get("phone") or "").strip() or None,
        }
        pois.append(poi)

    return pois


OVERTURE_OFFICE_CATEGORIES = {
    "real_estate_service",
    "professional_service",
    "financial_service",
    "legal_service",
    "accounting",
    "insurance",
    "it_service",
    "marketing",
    "corporate_office",
    "consulting",
    "architecture",
    "engineering",
    "business_service",
}

OVERTURE_INDOOR_SPORTS = {
    "gym",
    "fitness_studio",
    "sport_or_fitness_facility",
    "sport_or_recreation_club",
    "bowling_alley",
    "recreational_equipment_rental",
}

OVERTURE_OUTDOOR_SPORTS = {
    "park",
    "sport_court",
    "sport_field",
    "swimming_pool",
    "golf_course",
    "playground",
    "dog_park",
    "national_park",
    "sport_league",
    "sport_team",
    "sports_and_recreation",
}

OVERTURE_CIVIC_ARTS = {
    "museum",
    "art_gallery",
    "stadium_arena",
}

OVERTURE_OUTDOOR_ARTS = {
    "amusement_park",
    "zoo",
    "aquarium",
    "animal_attraction",
}

SOURCE_TRUST_RANK: dict[str, int] = {
    "osm": 0,
    "overture": 1,
    "foursquare": 1,
}

TRUST_SORT_RANK: dict[str, int] = {
    "verified": 0,
    "unrated": 1,
    "unverified": 2,
}

_STOPWORDS_RE = re.compile(
    r"\b(?:" + re.escape(PLACE.name.lower()) + r"|city|branch|ph|philippines|inc|corp|corporation|co|ltd)\b"
)


def normalize_place_name(name: str | None) -> str:
    """Normalize a POI name for cross-source duplicate matching."""
    if not name:
        return ""
    cleaned = name.lower().strip()
    cleaned = re.sub(r"[^a-z0-9\s]", " ", cleaned)
    cleaned = _STOPWORDS_RE.sub(" ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _names_match(norm_a: str, norm_b: str) -> bool:
    """Return True if two normalized place names refer to the same business."""
    if not norm_a or not norm_b:
        return False
    if norm_a == norm_b:
        return True
    shorter, longer = (norm_a, norm_b) if len(norm_a) <= len(norm_b) else (norm_b, norm_a)
    if len(shorter) >= 5 and shorter in longer:
        return True
    tokens_a = set(norm_a.split())
    tokens_b = set(norm_b.split())
    if not tokens_a or not tokens_b:
        return False
    jaccard = len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
    return jaccard >= 0.70


def classify_overture_place(
    basic_category: str | None,
    tax_primary: str | None,
    root_cat: str | None,
) -> dict[str, Any] | None:
    """Map an Overture Places taxonomy record into canonical POI category + building class."""
    basic = (basic_category or "").strip().lower()
    primary = (tax_primary or "").strip().lower()
    root = (root_cat or "").strip().lower()
    cat = basic or primary or root
    if not root or root == "geographic_entities":
        return None

    def _make(
        category: str,
        mapped_bclass: str | None,
        building_applicable: bool,
        priority: int,
    ) -> dict[str, Any]:
        return {
            "poi_key": "overture",
            "poi_value": cat,
            "category": category,
            "mapped_bclass": mapped_bclass,
            "building_applicable": building_applicable,
            "priority": priority,
        }

    if root == "food_and_drink":
        return _make("food", "commercial", True, 75)

    if root == "shopping":
        if cat == "pharmacy_and_drug_store" or "pharmacy" in cat:
            return _make("healthcare", "retail", True, 80)
        if any(k in cat for k in ("mall", "shopping_center", "department_store", "supermarket", "grocery_store")):
            return _make("retail", "retail", True, 90)
        if "auto_dealer" in cat or "automotive" in cat:
            return _make("commercial", "commercial", True, 75)
        return _make("retail", "retail", True, 78)

    if root == "services_and_business":
        if cat == "bank_or_credit_union" or "bank" in cat:
            return _make("commercial", "commercial", True, 82)
        if any(k in cat for k in ("industrial", "manufactur", "warehouse", "factory")):
            return _make("industrial", "industrial", True, 78)
        if cat in OVERTURE_OFFICE_CATEGORIES or any(
            k in cat
            for k in (
                "real_estate",
                "professional",
                "financial",
                "legal",
                "accounting",
                "insurance",
                "consulting",
                "architect",
                "engineer",
                "corporate",
                "office",
            )
        ):
            return _make("office", "office", True, 75)
        return _make("commercial", "commercial", True, 72)

    if root == "lifestyle_services":
        return _make("commercial", "commercial", True, 72)

    if root == "lodging":
        return _make("hotel", "hotel", True, 84)

    if root == "health_care":
        if "hospital" in cat:
            return _make("healthcare", "hospital", True, 90)
        return _make("healthcare", "healthcare", True, 80)

    if root == "education":
        if "university" in cat:
            return _make("education", "university", True, 88)
        if "college" in cat:
            return _make("education", "college", True, 85)
        return _make("education", "school", True, 85)

    if root == "community_and_government":
        if any(
            k in cat
            for k in ("government", "city_hall", "police", "fire_station", "courthouse", "post_office", "embassy")
        ):
            return _make("civic", "government", True, 85)
        return _make("civic", "civic", True, 80)

    if root == "cultural_and_historic":
        if any(
            k in cat
            for k in ("worship", "church", "chapel", "cathedral", "mosque", "temple", "religious")
        ):
            return _make("religious", "religious", True, 85)
        if any(k in cat for k in ("cultural_center", "museum")):
            return _make("civic", "civic", True, 75)
        return _make("leisure", None, False, 25)

    if root == "travel_and_transportation":
        if "parking" in cat:
            return _make("other", None, False, 10)
        if any(k in cat for k in ("airport", "train_station", "bus_station", "transit", "air_transport")):
            return _make("civic", "civic", True, 80)
        return _make("commercial", "commercial", True, 76)

    if root == "sports_and_recreation":
        if cat in OVERTURE_INDOOR_SPORTS:
            return _make("leisure", "commercial", True, 74)
        if cat in OVERTURE_OUTDOOR_SPORTS:
            return _make("leisure", None, False, 25)
        return _make("leisure", None, False, 25)

    if root == "arts_and_entertainment":
        if cat in OVERTURE_CIVIC_ARTS:
            return _make("civic", "civic", True, 78)
        if cat in OVERTURE_OUTDOOR_ARTS:
            return _make("leisure", None, False, 25)
        return _make("commercial", "commercial", True, 76)

    return None


def fetch_overture_places(
    min_confidence: float = 0.65,
    min_update_year: int = OVERTURE_MIN_UPDATE_YEAR,
) -> list[dict[str, Any]]:
    """Fetch Overture Maps Places (Meta, Foursquare, Microsoft, AllThePlaces, Uberall) in Bacolod."""
    try:
        from scripts.fetch_bacolod import (
            OVERTURE_RELEASE,
            S3_BASE,
            overture_path,
            bbox_where,
            create_duckdb_connection,
        )
    except ImportError:
        from fetch_bacolod import (  # type: ignore[no-redef]
            OVERTURE_RELEASE,
            S3_BASE,
            overture_path,
            bbox_where,
            create_duckdb_connection,
        )

    print(
        f"Fetching Overture Places ({OVERTURE_RELEASE}, confidence >= {min_confidence:.2f}, "
        f"update_year >= {min_update_year})..."
    )
    con = create_duckdb_connection()
    p_path = overture_path("places", "place")
    rows = con.execute(
        f"""
        SELECT
            id,
            names.primary AS name,
            basic_category,
            taxonomy.primary AS tax_primary,
            taxonomy.hierarchy[1] AS root_cat,
            confidence,
            sources[1].dataset AS dataset,
            sources[1].update_time AS update_time,
            brand.names.primary AS brand,
            addresses[1].freeform AS addr_street,
            websites[1] AS website,
            phones[1] AS phone,
            ST_X(geometry) AS lon,
            ST_Y(geometry) AS lat
        FROM read_parquet('{p_path}')
        WHERE {bbox_where()}
          AND geometry IS NOT NULL
          AND names.primary IS NOT NULL
          AND (operating_status IS NULL OR LOWER(operating_status) != 'closed')
          AND COALESCE(confidence, 0.0) >= {float(min_confidence)}
          AND (
              (sources[1].update_time IS NOT NULL AND SUBSTR(sources[1].update_time, 1, 4) >= '{int(min_update_year)}')
              OR (sources[1].update_time IS NULL AND COALESCE(confidence, 0.0) >= 0.80)
          )
        """
    ).fetchall()

    pois: list[dict[str, Any]] = []
    for (
        fid,
        name,
        basic_category,
        tax_primary,
        root_cat,
        confidence,
        dataset,
        update_time,
        brand,
        addr_street,
        website,
        phone,
        lon,
        lat,
    ) in rows:
        if lon is None or lat is None or not name:
            continue
        classified = classify_overture_place(basic_category, tax_primary, root_cat)
        if classified is None:
            continue
        is_fsq = str(dataset or "").strip().lower() == "foursquare"
        source = "foursquare" if is_fsq else "overture"
        poi_id = f"fsq-ovt/{fid}" if is_fsq else f"ovt/{fid}"
        updated = str(update_time)[:10] if update_time else None
        pois.append(
            {
                "osm_id": poi_id,
                "osm_type": "place",
                "source": source,
                "confidence": round(float(confidence or 0.0), 2),
                "name": str(name).strip(),
                "lon": round(float(lon), 7),
                "lat": round(float(lat), 7),
                "poi_key": classified["poi_key"],
                "poi_value": classified["poi_value"],
                "category": classified["category"],
                "mapped_bclass": classified["mapped_bclass"],
                "building_applicable": classified["building_applicable"],
                "priority": classified["priority"],
                "brand": str(brand or "").strip() or None,
                "cuisine": None,
                "addr_street": str(addr_street or "").strip() or None,
                "website": str(website or "").strip() or None,
                "phone": str(phone or "").strip() or None,
                "updated": updated,
            }
        )

    print(f"Loaded {len(pois):,} fresh Overture/Foursquare place candidates.")
    return pois


def classify_foursquare_labels(labels: list[str] | str | None) -> dict[str, Any] | None:
    """Classify Foursquare OS Places fsq_category_labels into canonical POI + building class."""
    if not labels:
        return None
    label_list = [labels] if isinstance(labels, str) else [str(x) for x in labels if x]
    if not label_list:
        return None

    primary_label = label_list[0].strip()
    lower = primary_label.lower()
    leaf = lower.split(">")[-1].strip()
    slug = re.sub(r"[^a-z0-9]+", "_", leaf).strip("_") or "place"

    def _make(
        category: str,
        mapped_bclass: str | None,
        building_applicable: bool,
        priority: int,
    ) -> dict[str, Any]:
        return {
            "poi_key": "foursquare",
            "poi_value": slug,
            "category": category,
            "mapped_bclass": mapped_bclass,
            "building_applicable": building_applicable,
            "priority": priority,
        }

    if "dining and drinking" in lower:
        return _make("food", "commercial", True, 80)

    if "retail" in lower:
        if "pharmacy" in lower:
            return _make("healthcare", "retail", True, 84)
        if any(k in lower for k in ("shopping mall", "department store", "supermarket", "grocery")):
            return _make("retail", "retail", True, 92)
        return _make("retail", "retail", True, 82)

    if "business and professional services" in lower:
        if any(k in lower for k in ("bank", "credit union", "atm", "currency")):
            return _make("commercial", "commercial", True, 84)
        if any(k in lower for k in ("factory", "manufacturer", "warehouse", "industrial")):
            return _make("industrial", "industrial", True, 82)
        if any(
            k in lower
            for k in (
                "office",
                "real estate",
                "legal",
                "accounting",
                "insurance",
                "financial",
                "consulting",
                "tech",
            )
        ):
            return _make("office", "office", True, 80)
        return _make("commercial", "commercial", True, 78)

    if "health and medicine" in lower:
        if "hospital" in lower:
            return _make("healthcare", "hospital", True, 94)
        return _make("healthcare", "healthcare", True, 84)

    if "lodging" in lower:
        return _make("hotel", "hotel", True, 86)

    if "education" in lower:
        if "university" in lower:
            return _make("education", "university", True, 90)
        if "college" in lower:
            return _make("education", "college", True, 88)
        return _make("education", "school", True, 88)

    if "community and government" in lower:
        if any(k in lower for k in ("church", "mosque", "temple", "synagogue", "spiritual", "worship")):
            return _make("religious", "religious", True, 88)
        if any(k in lower for k in ("government", "city hall", "police", "fire station", "courthouse", "post office")):
            return _make("civic", "government", True, 88)
        return _make("civic", "civic", True, 82)

    if "travel and transportation" in lower:
        if "parking" in lower:
            return _make("other", None, False, 10)
        if any(k in lower for k in ("airport", "bus station", "train station", "ferry", "terminal")):
            return _make("civic", "civic", True, 82)
        return _make("commercial", "commercial", True, 78)

    if "arts and entertainment" in lower:
        if any(k in lower for k in ("museum", "art gallery", "stadium")):
            return _make("civic", "civic", True, 80)
        if any(k in lower for k in ("zoo", "aquarium", "theme park")):
            return _make("leisure", None, False, 25)
        return _make("commercial", "commercial", True, 78)

    if "sports and recreation" in lower:
        if any(k in lower for k in ("gym", "fitness", "bowling", "martial arts", "yoga")):
            return _make("leisure", "commercial", True, 76)
        return _make("leisure", None, False, 25)

    if "landmarks and outdoors" in lower:
        return _make("leisure", None, False, 25)

    return None


def load_foursquare_places(
    parquet_path: str,
    min_refresh_year: int = OVERTURE_MIN_UPDATE_YEAR,
) -> list[dict[str, Any]]:
    """Load standalone Foursquare OS Places Parquet file(s) filtered to the Bacolod bbox."""
    import duckdb

    print(f"Loading Foursquare OS Places from {parquet_path}...")
    con = duckdb.connect()
    if parquet_path.startswith(("http://", "https://", "hf://", "s3://")):
        con.execute("INSTALL httpfs; LOAD httpfs;")
    cols = {
        str(row[0]).lower()
        for row in con.execute("DESCRIBE SELECT * FROM read_parquet(?) LIMIT 0", [parquet_path]).fetchall()
    }
    has_refreshed = "date_refreshed" in cols
    refresh_select = ", date_refreshed" if has_refreshed else ", NULL AS date_refreshed"
    refresh_where = (
        f"AND (date_refreshed IS NULL OR SUBSTR(CAST(date_refreshed AS VARCHAR), 1, 4) >= '{int(min_refresh_year)}')"
        if has_refreshed
        else ""
    )
    rows = con.execute(
        f"""
        SELECT
            fsq_place_id,
            name,
            latitude,
            longitude,
            fsq_category_labels,
            address,
            website,
            tel
            {refresh_select}
        FROM read_parquet(?)
        WHERE latitude BETWEEN ? AND ?
          AND longitude BETWEEN ? AND ?
          AND date_closed IS NULL
          AND name IS NOT NULL
          {refresh_where}
        """,
        [parquet_path, SOUTH, NORTH, WEST, EAST],
    ).fetchall()

    pois: list[dict[str, Any]] = []
    for fid, name, lat, lon, labels, address, website, tel, date_refreshed in rows:
        classified = classify_foursquare_labels(labels)
        if classified is None or lon is None or lat is None:
            continue
        updated = str(date_refreshed)[:10] if date_refreshed else None
        pois.append(
            {
                "osm_id": f"fsq/{fid}",
                "osm_type": "place",
                "source": "foursquare",
                "confidence": 0.85,
                "name": str(name).strip(),
                "lon": round(float(lon), 7),
                "lat": round(float(lat), 7),
                "poi_key": classified["poi_key"],
                "poi_value": classified["poi_value"],
                "category": classified["category"],
                "mapped_bclass": classified["mapped_bclass"],
                "building_applicable": classified["building_applicable"],
                "priority": classified["priority"],
                "brand": None,
                "cuisine": None,
                "addr_street": str(address or "").strip() or None,
                "website": str(website or "").strip() or None,
                "phone": str(tel or "").strip() or None,
                "updated": updated,
            }
        )

    print(f"Loaded {len(pois):,} standalone Foursquare places.")
    return pois


# Places outside Bacolod that Overture/Foursquare sometimes geocode into the city.
# Matched only as a trailing ", X" / " - X" locality suffix so Bacolod branches of
# businesses named after these places (e.g. "Solid Manila Bldg") are kept.
_FOREIGN_LOCALITY_SUFFIXES = tuple(PLACE.foreign_locality_suffixes())
_FOREIGN_SUFFIX_RE = re.compile(
    r"(?:,|\s[-–—|]\s)\s*(?:" + "|".join(re.escape(s) for s in _FOREIGN_LOCALITY_SUFFIXES) + r")\s*$",
    re.IGNORECASE,
)
# Landmarks that cannot exist inside the place (airports elsewhere), wherever they appear in the name.
_FOREIGN_LANDMARK_RE = re.compile(
    r"\b(?:ninoy\s+aquino\s+international|naia|mactan[-\s]cebu\s+international|"
    r"manila\s+international\s+airport|clark\s+international)\b",
    re.IGNORECASE,
)


def _place_coord_key(poi: dict[str, Any]) -> tuple[float, float]:
    return (round(float(poi["lon"]), 5), round(float(poi["lat"]), 5))


def filter_unreliable_places(
    pois: list[dict[str, Any]], stack_min_names: int = 3
) -> tuple[list[dict[str, Any]], collections.Counter[str]]:
    """Drop third-party places whose coordinates cannot be trusted at building precision.

    - Geocoder stacks: when >= stack_min_names differently-named places share one
      coordinate (~1 m), the point is a street/barangay/city fallback geocode, not
      a rooftop. Snapping those to "the nearest building" piles unrelated places
      onto whatever building sits at the fallback point.
    - Out-of-area names: places that are explicitly elsewhere (e.g. NAIA Terminal 2,
      "Antipolo, Pontevedra") but were geocoded into the Bacolod bbox.

    OSM POIs are hand-placed and always kept.
    """
    names_at: dict[tuple[float, float], set[str]] = collections.defaultdict(set)
    for poi in pois:
        if str(poi.get("source") or "osm") != "osm":
            names_at[_place_coord_key(poi)].add(normalize_place_name(poi.get("name")) or str(poi.get("osm_id")))

    kept: list[dict[str, Any]] = []
    dropped: collections.Counter[str] = collections.Counter()
    for poi in pois:
        if str(poi.get("source") or "osm") == "osm":
            kept.append(poi)
            continue
        name = str(poi.get("name") or "").strip()
        if _FOREIGN_LANDMARK_RE.search(name) or _FOREIGN_SUFFIX_RE.search(name):
            dropped["out_of_area"] += 1
            continue
        if len(names_at[_place_coord_key(poi)]) >= stack_min_names:
            dropped["stacked_geocode"] += 1
            continue
        kept.append(poi)
    return kept, dropped


def filter_wrong_barangay_pois(pois: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Drop third-party POIs whose address names a different Bacolod barangay >250 m away."""
    kept: list[dict[str, Any]] = []
    dropped = 0
    for poi in pois:
        if str(poi.get("source") or "osm") != "osm" and int(poi.get("barangay_vote") or 0) <= -2:
            dropped += 1
            continue
        kept.append(poi)
    return kept, dropped


def normalize_phone(phone: str | None) -> str:
    """Normalize a PH phone number for cross-source matching ("" when unusable).

    Uses the first number when several are listed, strips the +63 / 0 trunk prefix,
    and drops Metro Manila (02) landlines: in Bacolod those are national chain
    hotlines (McDonald's, Shell, Seaoil...) shared by unrelated branches.
    """
    first = re.split(r"[;,/]", str(phone or ""), maxsplit=1)[0]
    digits = re.sub(r"\D", "", first)
    if digits.startswith("63"):
        digits = digits[2:]
    digits = digits.lstrip("0")
    if len(digits) < 7 or digits.startswith("2"):
        return ""
    return digits


def deduplicate_pois(
    pois: list[dict[str, Any]],
    radius_m: float = 35.0,
    phone_radius_m: float = 3000.0,
    phone_max_records: int = 2,
) -> list[dict[str, Any]]:
    """Deduplicate POIs across sources, keeping highest-trust records.

    Two records are the same place when their names match and either they lie
    within radius_m, or they share a phone number that is specific to that
    business (used by <= phone_max_records records; chain hotlines are ignored)
    and lie within phone_radius_m. The phone rule catches third-party copies
    geocoded hundreds of metres away from the correctly placed (usually OSM) pin.
    """
    if not pois:
        return []

    phone_counts = collections.Counter(normalize_phone(p.get("phone")) for p in pois)
    phone_counts.pop("", None)

    ordered = sorted(
        pois,
        key=lambda p: (
            SOURCE_TRUST_RANK.get(str(p.get("source") or "osm"), 99),
            -float(p.get("confidence") or 0.0),
            -int(p.get("priority") or 0),
        ),
    )

    kept: list[dict[str, Any]] = []
    kept_pts_m: list[Point] = []
    kept_norms: list[str] = []
    # Incremental spatial buckets in meters (cell size = radius_m) for O(1) lookup
    cell_size = max(radius_m, 1.0)
    grid: dict[tuple[int, int], list[int]] = collections.defaultdict(list)
    kept_by_phone: dict[str, list[int]] = collections.defaultdict(list)

    for poi in ordered:
        x_m = float(poi["lon"]) * M_PER_DEG_LON
        y_m = float(poi["lat"]) * M_PER_DEG_LAT
        pt_m = Point(x_m, y_m)
        norm = normalize_place_name(poi.get("name"))
        cx = int(math.floor(x_m / cell_size))
        cy = int(math.floor(y_m / cell_size))

        duplicate_idx: int | None = None
        if norm:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for idx in grid.get((cx + dx, cy + dy), ()):
                        if kept_pts_m[idx].distance(pt_m) <= radius_m and _names_match(
                            norm, kept_norms[idx]
                        ):
                            duplicate_idx = idx
                            break
                    if duplicate_idx is not None:
                        break
                if duplicate_idx is not None:
                    break

        if duplicate_idx is not None:
            # Backfill missing optional metadata onto the higher-trust kept POI
            target = kept[duplicate_idx]
            for opt_key in ("brand", "phone", "website", "addr_street"):
                if not target.get(opt_key) and poi.get(opt_key):
                    target[opt_key] = poi[opt_key]
            continue

        new_idx = len(kept)
        kept.append(poi)
        kept_pts_m.append(pt_m)
        kept_norms.append(norm)
        grid[(cx, cy)].append(new_idx)

    # Second pass: merge far-apart copies sharing a business-specific phone. Runs after
    # the proximity pass so phones backfilled onto OSM pins (which often lack one) count.
    merged: list[dict[str, Any]] = []
    merged_pts: list[Point] = []
    merged_norms: list[str] = []
    for poi, pt_m, norm in zip(kept, kept_pts_m, kept_norms):
        phone = normalize_phone(poi.get("phone"))
        target: dict[str, Any] | None = None
        if norm and phone and phone_counts.get(phone, 0) <= phone_max_records:
            for idx in kept_by_phone.get(phone, ()):
                if merged_pts[idx].distance(pt_m) <= phone_radius_m and _names_match(
                    norm, merged_norms[idx]
                ):
                    target = merged[idx]
                    break
        if target is not None:
            for opt_key in ("brand", "website", "addr_street"):
                if not target.get(opt_key) and poi.get(opt_key):
                    target[opt_key] = poi[opt_key]
            continue
        if phone:
            kept_by_phone[phone].append(len(merged))
        merged.append(poi)
        merged_pts.append(pt_m)
        merged_norms.append(norm)

    return merged


def match_pois_to_buildings(
    pois: list[dict[str, Any]],
    building_ids: list[str],
    building_geoms_m: list[Any],
    max_distance_m: float = 30.0,
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Match each POI pin to its containing or nearest building within precision distance limits."""
    building_matches: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    if not building_ids or not pois:
        for poi in pois:
            poi["matched_building_id"] = None
            poi["match_method"] = "unmatched"
            poi["match_distance_m"] = None
        return pois, building_matches

    tree = STRtree(building_geoms_m)
    areas = [g.area for g in building_geoms_m]

    for poi in pois:
        src = str(poi.get("source") or "osm")
        poi_max_dist = (
            min(max_distance_m, 25.0)
            if src == "osm"
            else min(max_distance_m, THIRD_PARTY_NEAREST_MAX_DIST_M)
        )
        pt_m = Point(poi["lon"] * M_PER_DEG_LON, poi["lat"] * M_PER_DEG_LAT)
        containing_indices = tree.query(pt_m, predicate="intersects")

        if len(containing_indices) > 0:
            # Prefer smallest non-sliver containing footprint (>= 6 m^2)
            non_sliver = [int(idx) for idx in containing_indices if areas[int(idx)] >= 6.0]
            pool = non_sliver if non_sliver else [int(idx) for idx in containing_indices]
            best_idx = min(pool, key=lambda idx: areas[idx])
            dist_m = 0.0
            method = "inside"
        else:
            nearest_idx = int(tree.nearest(pt_m))
            dist_m = float(building_geoms_m[nearest_idx].distance(pt_m))
            if dist_m <= poi_max_dist:
                best_idx = nearest_idx
                # Guard third-party snaps onto tiny <25 m^2 sheds when a real building sits nearby
                if src != "osm" and areas[best_idx] < 25.0:
                    nearby = tree.query(pt_m.buffer(poi_max_dist), predicate="intersects")
                    larger_cands = [
                        (float(building_geoms_m[int(ci)].distance(pt_m)), int(ci))
                        for ci in nearby
                        if areas[int(ci)] >= 40.0
                    ]
                    if larger_cands:
                        larger_cands.sort(key=lambda item: item[0])
                        if larger_cands[0][0] <= poi_max_dist:
                            dist_m, best_idx = larger_cands[0]
                method = "nearest"
            else:
                poi["matched_building_id"] = None
                poi["match_method"] = "unmatched"
                poi["match_distance_m"] = None
                continue

        bid = building_ids[best_idx]
        dist_rounded = round(dist_m, 1)
        poi["matched_building_id"] = bid
        poi["match_method"] = method
        poi["match_distance_m"] = dist_rounded
        building_matches[bid].append(poi)

    return pois, building_matches


NAME_KEYWORD_RULES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\buniversity\b", re.I), "university", "verified"),
    (re.compile(r"\bcollege\b", re.I), "college", "verified"),
    (
        re.compile(
            r"\b(?:school|elementary|national high|academy|montessori|kindergarten|day\s?care|learning cent(?:er|re))\b",
            re.I,
        ),
        "school",
        "verified",
    ),
    (
        re.compile(r"\b(?:hospital|medical cent(?:er|re)|doctors|infirmary)\b", re.I),
        "hospital",
        "verified",
    ),
    (
        re.compile(
            r"\b(?:clinic|lying[-\s]?in|maternity|health cent(?:er|re)|diagnostic|dialysis)\b",
            re.I,
        ),
        "healthcare",
        "verified",
    ),
    (
        re.compile(
            r"\b(?:cathedral|parish|church|chapel|mosque|temple|kingdom hall|iglesia ni cristo|convent|seminary|shrine)\b",
            re.I,
        ),
        "religious",
        "verified",
    ),
    (
        re.compile(
            r"\b(?:(?:barangay|brgy\.?)(?:\s+[a-z0-9-]+){0,2}\s+hall|city hall|capitol|hall of justice|courthouse|police|fire station|post office|bureau of|municipal)\b",
            re.I,
        ),
        "government",
        "verified",
    ),
    (
        re.compile(
            r"\b(?:covered court|gymnasium|auditorium|coliseum|museum|library|bus terminal|ferry terminal|seaport)\b",
            re.I,
        ),
        "civic",
        "verified",
    ),
    (
        re.compile(
            r"\b(?:hotel|resort|pension(?:\s+house)?|apartelle|hostel|motel|inn|suites)\b",
            re.I,
        ),
        "hotel",
        "verified",
    ),
    (re.compile(r"\b(?:dorm(?:itory)?|boarding house)\b", re.I), "dormitory", "verified"),
    (
        re.compile(r"\b(?:apartments?|condo(?:minium)?|residences?|townhouse)\b", re.I),
        "apartments",
        "verified",
    ),
    (
        re.compile(
            r"\b(?:warehouse|bodega|factory|ice plant|cold storage|substation|depot|motorpool|foundry|fabrication)\b",
            re.I,
        ),
        "industrial",
        "medium",
    ),
    (
        re.compile(
            r"\b(?:mall|supermarket|hypermarket|public market|talipapa|grocery|hardware|pharmacy|drugstore|mart)\b",
            re.I,
        ),
        "retail",
        "medium",
    ),
    (
        re.compile(
            r"\b(?:corporate|bpo|call center|it park|tech hub|offices?)\b",
            re.I,
        ),
        "office",
        "medium",
    ),
    (
        re.compile(
            r"\b(?:bank|pawnshop|trading|enterprises|merchandising|auto supply|gas(?:oline)? station|plaza|arcade|sari[-\s]?sari)\b",
            re.I,
        ),
        "commercial",
        "medium",
    ),
]


def classify_building_name(name: str | None) -> tuple[str, str] | None:
    """Classify a building directly from its proper name using Philippine keyword rules."""
    if not name:
        return None
    text = str(name).strip()
    if len(text) < 3:
        return None
    for pattern, bclass, conf in NAME_KEYWORD_RULES:
        if pattern.search(text):
            return bclass, conf
    return None


def _is_eligible_for_classification(poi: dict[str, Any]) -> bool:
    """Reject unverified or imprecise third-party snaps from changing building class."""
    src = str(poi.get("source") or "osm")
    if src == "osm":
        return True
    if poi.get("trust") == "unverified":
        return False
    if poi.get("match_method") == "inside":
        return True
    conf = float(poi.get("confidence") or 0.0)
    dist = float(poi.get("match_distance_m") or 0.0)
    return conf >= THIRD_PARTY_NEAREST_MIN_CONFIDENCE and dist <= THIRD_PARTY_NEAREST_MAX_DIST_M


def _has_verified_poi(pois: list[dict[str, Any]]) -> bool:
    """Return True if at least one eligible classifying POI is OSM or trust-verified."""
    return any(
        p.get("building_applicable")
        and p.get("mapped_bclass")
        and _is_eligible_for_classification(p)
        and (str(p.get("source") or "osm") == "osm" or p.get("trust") == "verified")
        for p in pois
    )


POI_SOURCE_WEIGHT: dict[str, float] = {
    "osm": 2.0,
    "overture": 1.0,
    "foursquare": 1.0,
}


def _pick_weighted_bclass(pois: list[dict[str, Any]]) -> str | None:
    """Pick highest trust x confidence x containment x priority weighted class."""
    scores: dict[str, float] = collections.defaultdict(float)
    for poi in pois:
        mapped = poi.get("mapped_bclass")
        if not poi.get("building_applicable") or not mapped:
            continue
        if not _is_eligible_for_classification(poi):
            continue
        src = str(poi.get("source") or "osm")
        src_w = POI_SOURCE_WEIGHT.get(src, 1.0)
        conf = 1.0 if src == "osm" else max(0.5, float(poi.get("confidence") or 0.7))
        contain_mult = 2.5 if poi.get("match_method") == "inside" else 1.0
        dist = float(poi.get("match_distance_m") or 0.0)
        weight = (src_w * conf * contain_mult * float(poi.get("priority") or 50)) / (1.0 + dist)
        scores[mapped] += weight

    if not scores:
        return None
    return max(scores.items(), key=lambda kv: kv[1])[0]


def _is_trusted_for_mixed_use(poi: dict[str, Any], threshold: float) -> bool:
    """Require OSM origin or confidence >= threshold before promoting to mixed_use."""
    if str(poi.get("source") or "osm") == "osm":
        return True
    return float(poi.get("confidence") or 0.0) >= threshold


def resolve_poi_building_class(
    pois: list[dict[str, Any]],
    orig_bclass: str,
    area_m2: float | None = None,
    in_residential_landuse: bool = False,
) -> str | None:
    """Resolve a building class from matched POIs, detecting genuine mixed-use shophouses."""
    applicable = [
        p
        for p in pois
        if p.get("building_applicable")
        and p.get("mapped_bclass")
        and _is_eligible_for_classification(p)
    ]
    if not applicable:
        return None

    dominant = _pick_weighted_bclass(applicable)
    if dominant is None:
        return None

    # Protect institutional anchors (schools, hospitals, churches, gov) unless >=2 distinct commercial groups co-exist inside
    if orig_bclass in INSTITUTIONAL_ANCHORS:
        high_conf_inst = [p for p in applicable if _is_trusted_for_mixed_use(p, 0.70)]
        inst_groups = {
            CLASS_TO_USE_GROUP.get(str(p["mapped_bclass"]), str(p["mapped_bclass"]))
            for p in high_conf_inst
        }
        non_inst = inst_groups - {"civic_edu", "healthcare", "religious"}
        if len(non_inst) >= 2 and all(
            any(p.get("match_method") == "inside" for p in high_conf_inst if CLASS_TO_USE_GROUP.get(str(p["mapped_bclass"])) == g)
            for g in non_inst
        ):
            return "mixed_use"
        if CLASS_TO_USE_GROUP.get(dominant) in {"civic_edu", "healthcare", "religious"}:
            return dominant
        return orig_bclass

    # Residential / apartment footprint with an inside commercial/office/healthcare/hotel tenant -> mixed_use
    if orig_bclass in RESIDENTIAL_OVERRIDABLE or orig_bclass == "apartments":
        if any(
            p.get("match_method") == "inside"
            and _is_trusted_for_mixed_use(p, 0.70)
            and CLASS_TO_USE_GROUP.get(str(p["mapped_bclass"]))
            in {"commercial_retail", "office", "healthcare", "hospitality"}
            for p in applicable
        ):
            return "mixed_use"

    # Residential-sized building (< 160 m^2) on residential landuse with a single small shop/food POI -> mixed_use shophouse
    if (
        area_m2 is not None
        and area_m2 < 160.0
        and in_residential_landuse
        and len(applicable) == 1
        and applicable[0].get("category") in {"food", "retail", "commercial"}
        and applicable[0].get("poi_value") not in {"mall", "supermarket", "department_store", "hospital", "hotel"}
    ):
        return "mixed_use"

    high_conf = [p for p in applicable if _is_trusted_for_mixed_use(p, 0.65)]
    groups = {
        CLASS_TO_USE_GROUP.get(str(p["mapped_bclass"]), str(p["mapped_bclass"]))
        for p in high_conf
    }

    # A hotel with only in-house restaurants/cafes/bars remains a hotel
    if groups == {"hospitality", "commercial_retail"}:
        non_food_commercial = [
            p
            for p in high_conf
            if CLASS_TO_USE_GROUP.get(str(p["mapped_bclass"])) == "commercial_retail"
            and p.get("category") != "food"
        ]
        if not non_food_commercial:
            return "hotel"

    if len(groups) >= 2:
        return "mixed_use"

    return dominant


def format_building_label(primary_name: str | None, poi_count: int) -> str | None:
    """Format a z16+ floating building label as 'Primary Name' or 'Primary Name (+N)'."""
    if not primary_name:
        return None
    clean = primary_name.strip()
    if not clean:
        return None
    if poi_count > 1:
        return f"{clean} (+{poi_count - 1})"
    return clean


def _resolve_orig_bclass(props: dict[str, Any]) -> str:
    """Recover the pre-enrichment Overture building class idempotently."""
    if "orig_bclass" in props and props["orig_bclass"] is not None:
        val = str(props["orig_bclass"]).lower().strip()
        return val or "unknown"
    if "class_source" in props:
        if props.get("class_source") == "overture":
            val = str(props.get("bclass") or "unknown").lower().strip()
            return val or "unknown"
        return "unknown"
    val = str(props.get("bclass") or "unknown").lower().strip()
    return val or "unknown"


def _poi_class_source(pois: list[dict[str, Any]], tier_suffix: str) -> str:
    """Return class_source provenance reflecting highest-trust eligible POI source."""
    applicable_sources = {
        str(p.get("source") or "osm")
        for p in pois
        if p.get("building_applicable")
        and p.get("mapped_bclass")
        and _is_eligible_for_classification(p)
    }
    if "osm" in applicable_sources:
        return f"osm_poi_{tier_suffix}"
    if "foursquare" in applicable_sources:
        return f"foursquare_poi_{tier_suffix}"
    return f"overture_poi_{tier_suffix}"


ARTERIAL_ROAD_CLASSES = {"trunk", "primary", "secondary"}


def load_roads_by_tier(roads_pmtiles_path: Path, tmp_dir: Path) -> list[Any]:
    """Extract arterial roads (trunk/primary/secondary) in metric coordinates."""
    if not roads_pmtiles_path.exists():
        print(f"Roads PMTiles not found at {roads_pmtiles_path}; skipping road-frontage inference.")
        return []

    extracted = tmp_dir / "extracted_roads.geojsonl"
    print(f"Extracting arterial roads from {roads_pmtiles_path}...")
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

    arterial_geoms_m: list[Any] = []
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
            if geom.is_empty:
                continue
            arterial_geoms_m.append(geom_to_meters(geom))

    print(f"Loaded {len(arterial_geoms_m):,} arterial road segments for morphology inference.")
    return arterial_geoms_m


def _rectangularity(geom_m: Any) -> float:
    area = float(geom_m.area)
    if area <= 0.0:
        return 0.0
    mrr_area = float(geom_m.minimum_rotated_rectangle.area)
    if mrr_area <= 0.0:
        return 0.0
    return min(1.0, area / mrr_area)


def classify_buildings(
    building_ids: list[str],
    building_geoms_m: list[Any],
    building_props: dict[str, dict[str, Any]],
    building_matches: dict[str, list[dict[str, Any]]],
    landuse_items: list[tuple[float, str, Any]] | None = None,
    compound_items: list[tuple[float, str, Any]] | None = None,
    arterial_roads_m: list[Any] | None = None,
) -> dict[str, Any]:
    """Reclassify buildings via 6-tier confidence-scored pipeline (POIs, names, compounds, landuse & morphology)."""
    lu_items = sorted(landuse_items or [], key=lambda item: item[0])
    lu_tree = STRtree([item[2] for item in lu_items]) if lu_items else None

    comp_items = sorted(compound_items or [], key=lambda item: item[0])
    comp_tree = STRtree([item[2] for item in comp_items]) if comp_items else None

    arterial_tree = STRtree(arterial_roads_m) if arterial_roads_m else None

    stats: dict[str, Any] = {
        "before_bclass": collections.Counter(),
        "after_bclass": collections.Counter(),
        "class_sources": collections.Counter(),
        "class_confidence": collections.Counter(),
        "height_reestimated": 0,
        "names_backfilled": 0,
        "buildings_with_pois": 0,
    }

    rep_pts_m = [g.representative_point() for g in building_geoms_m]
    areas_m2 = [float(g.area) for g in building_geoms_m]

    # Pass 1: Direct & contextual evidence (inside POI, Overture class, building name, compound, nearest POI, landuse)
    pass1_classes: list[str] = ["unknown"] * len(building_ids)
    unknown_indices: list[int] = []

    for idx, (bid, geom_m, rep_pt, area_m2) in enumerate(
        zip(building_ids, building_geoms_m, rep_pts_m, areas_m2)
    ):
        props = building_props[bid]
        orig_bclass = _resolve_orig_bclass(props)
        props["orig_bclass"] = orig_bclass
        stats["before_bclass"][orig_bclass] += 1

        for stale_key in ("poi_count", "poi_names", "poi_tags", "poi_match_distance_m"):
            props.pop(stale_key, None)
        if "orig_name" in props:
            orig_name = str(props.get("orig_name") or "").strip()
            if orig_name:
                props["name"] = orig_name
            else:
                props.pop("name", None)
        else:
            orig_name = str(props.get("name") or "").strip()

        matched = building_matches.get(bid, [])
        inside_pois = [p for p in matched if p.get("match_method") == "inside"]
        nearest_pois = [p for p in matched if p.get("match_method") == "nearest"]

        if matched:
            stats["buildings_with_pois"] += 1
            props["poi_count"] = len(matched)
            sorted_matched = sorted(
                matched,
                key=lambda p: (
                    0 if p.get("match_method") == "inside" else 1,
                    TRUST_SORT_RANK.get(str(p.get("trust") or "unrated"), 1),
                    SOURCE_TRUST_RANK.get(str(p.get("source") or "osm"), 99),
                    float(p.get("match_distance_m") or 0.0),
                    -float(p.get("confidence") or 0.0),
                    -int(p.get("priority") or 0),
                ),
            )
            unique_names: list[str] = []
            trusted_names: list[str] = []
            for p in sorted_matched:
                pname = p.get("name")
                if not pname:
                    continue
                if len(unique_names) < 4 and pname not in unique_names:
                    unique_names.append(pname)
                if (
                    (str(p.get("source") or "osm") == "osm" or p.get("trust") != "unverified")
                    and pname not in trusted_names
                ):
                    trusted_names.append(pname)
                if len(unique_names) >= 4 and trusted_names:
                    break

            if unique_names:
                props["poi_names"] = "; ".join(unique_names)
            if trusted_names and not props.get("name"):
                props["name"] = trusted_names[0]
                stats["names_backfilled"] += 1

            primary_poi = sorted_matched[0]
            props["poi_tags"] = f"{primary_poi['poi_key']}={primary_poi['poi_value']}"
            props["poi_match_distance_m"] = float(primary_poi.get("match_distance_m") or 0.0)

        landuse_class: str | None = None
        if lu_tree is not None:
            lu_cands = lu_tree.query(rep_pt, predicate="intersects")
            if len(lu_cands) > 0:
                landuse_class = lu_items[int(min(lu_cands))][1]
        in_res_landuse = landuse_class == "residential"

        compound_class: str | None = None
        if comp_tree is not None:
            comp_cands = comp_tree.query(rep_pt, predicate="intersects")
            if len(comp_cands) > 0:
                compound_class = comp_items[int(min(comp_cands))][1]

        bldg_area = float(props.get("area_m2") or area_m2)
        inside_winner = resolve_poi_building_class(
            inside_pois, orig_bclass, area_m2=bldg_area, in_residential_landuse=in_res_landuse
        )
        nearest_winner = resolve_poi_building_class(
            nearest_pois, orig_bclass, area_m2=bldg_area, in_residential_landuse=in_res_landuse
        )
        name_hit = classify_building_name(orig_name)

        new_bclass = orig_bclass
        class_source = "unknown"
        class_confidence = "unknown"

        # 1. Eligible inside POI overrides generic/residential footprints
        if inside_winner and (
            orig_bclass in GENERIC_CLASSES
            or orig_bclass in RESIDENTIAL_OVERRIDABLE
            or orig_bclass == "apartments"
        ):
            new_bclass = inside_winner
            class_source = _poi_class_source(inside_pois, "inside")
            class_confidence = "verified" if _has_verified_poi(inside_pois) else "medium"
        # 2. Preserve explicit Overture class
        elif orig_bclass not in GENERIC_CLASSES:
            new_bclass = orig_bclass
            class_source = "overture"
            class_confidence = "verified"
        # 3. Building proper name keyword classification (e.g. "Barangay Hall", "Elementary School")
        elif name_hit is not None:
            new_bclass, class_confidence = name_hit
            class_source = "name_keyword"
        # 4. Enclosing OSM campus/mall/church/hospital compound polygon
        elif compound_class is not None:
            new_bclass = compound_class
            class_source = "osm_compound"
            class_confidence = "verified"
        # 5. Eligible nearest POI within precision snap radius
        elif nearest_winner:
            new_bclass = nearest_winner
            class_source = _poi_class_source(nearest_pois, "nearest")
            class_confidence = "verified" if class_source == "osm_poi_nearest" else "medium"
        # 6. Enclosing OSM/Overture landuse polygon
        elif landuse_class is not None:
            new_bclass = landuse_class
            class_source = "osm_landuse"
            class_confidence = "medium"

        props["bclass"] = new_bclass
        props["class_source"] = class_source
        props["class_confidence"] = class_confidence
        pass1_classes[idx] = new_bclass

        if new_bclass == "unknown":
            unknown_indices.append(idx)

    # Pass 2: Morphology + Road-Frontage Spatial Inference for remaining unknowns
    if unknown_indices:
        centroid_tree = STRtree(rep_pts_m)
        comm_classes = {"commercial", "retail", "office", "hotel", "resort", "mixed_use"}
        ind_classes = {"industrial", "warehouse", "factory", "manufacture"}
        res_classes = set(RESIDENTIAL_OVERRIDABLE) | {"apartments", "dormitory"}

        for idx in unknown_indices:
            bid = building_ids[idx]
            geom_m = building_geoms_m[idx]
            rep_pt = rep_pts_m[idx]
            area_m2 = float(building_props[bid].get("area_m2") or areas_m2[idx])

            dist_art = math.inf
            if arterial_tree is not None and arterial_roads_m:
                nearest_art_idx = int(arterial_tree.nearest(geom_m))
                dist_art = float(geom_m.distance(arterial_roads_m[nearest_art_idx]))

            n150 = centroid_tree.query(rep_pt.buffer(150.0), predicate="intersects")
            comm_80 = 0
            comm_100 = 0
            comm_60 = 0
            ind_150 = 0
            res_80 = 0
            small_50 = 0
            cluster_50 = 0

            for ni_raw in n150:
                ni = int(ni_raw)
                if ni == idx:
                    continue
                d = float(rep_pt.distance(rep_pts_m[ni]))
                nc = pass1_classes[ni]
                na = areas_m2[ni]
                if d <= 50.0:
                    if 20.0 <= na <= 160.0:
                        small_50 += 1
                    if 20.0 <= na <= 320.0:
                        cluster_50 += 1
                if d <= 60.0 and nc in comm_classes:
                    comm_60 += 1
                if d <= 80.0:
                    if nc in comm_classes:
                        comm_80 += 1
                    elif nc in res_classes:
                        res_80 += 1
                if d <= 100.0 and nc in comm_classes:
                    comm_100 += 1
                if d <= 150.0 and nc in ind_classes:
                    ind_150 += 1

            inferred_class = "unknown"
            inferred_source = "unknown"

            if dist_art <= 28.0 and (comm_80 >= 2 or (area_m2 >= 300.0 and comm_100 >= 1)):
                if area_m2 >= 260.0:
                    inferred_class = "commercial"
                    inferred_source = "morph_arterial"
                elif area_m2 >= 50.0:
                    inferred_class = "mixed_use"
                    inferred_source = "morph_arterial"
            elif (
                area_m2 >= 750.0
                and _rectangularity(geom_m) >= 0.70
                and (ind_150 >= 1 or (area_m2 >= 1200.0 and small_50 < 8))
            ):
                inferred_class = "industrial"
                inferred_source = "morph_industrial"
            elif (
                20.0 <= area_m2 <= 320.0
                and (dist_art > 28.0 or comm_60 == 0)
                and (cluster_50 >= 2 or res_80 >= 1)
            ):
                inferred_class = "residential"
                inferred_source = "morph_residential"

            if inferred_class != "unknown":
                props = building_props[bid]
                props["bclass"] = inferred_class
                props["class_source"] = inferred_source
                props["class_confidence"] = "inferred"

    # Tally final stats & re-estimate heights if estimated
    for bid in building_ids:
        props = building_props[bid]
        new_bclass = str(props.get("bclass") or "unknown")
        class_source = str(props.get("class_source") or "unknown")
        class_conf = str(props.get("class_confidence") or "unknown")

        stats["after_bclass"][new_bclass] += 1
        stats["class_sources"][class_source] += 1
        stats["class_confidence"][class_conf] += 1

        if props.get("height_source") == "estimated":
            eff_h, h_src = estimate_building_height(
                props.get("height"),
                props.get("num_floors"),
                new_bclass,
                props.get("area_m2"),
            )
            if eff_h != props.get("effective_height"):
                stats["height_reestimated"] += 1
            props["effective_height"] = eff_h
            props["height_source"] = h_src
            min_h = float(props.get("min_height") or 0.0)
            if min_h >= eff_h:
                props["min_height"] = 0.0

    return stats


def load_stitched_buildings(
    pmtiles_path: Path, tmp_dir: Path
) -> tuple[list[str], list[Any], list[Any], dict[str, dict[str, Any]]]:
    """Extract z16 buildings from PMTiles and stitch duplicate tile-boundary IDs."""
    extracted = tmp_dir / "extracted_buildings.geojsonl"
    print(f"Extracting buildings from {pmtiles_path}...")
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
            str(pmtiles_path),
            "buildings",
        ],
        check=True,
    )

    grouped_geoms: dict[str, list[Any]] = {}
    props_by_id: dict[str, dict[str, Any]] = {}
    raw_rows = 0

    with extracted.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            raw_rows += 1
            feat = json.loads(line)
            props = feat.get("properties") or {}
            fid = str(props.get("id") or f"b-{raw_rows}")
            geom = shape(feat["geometry"])
            if fid not in grouped_geoms:
                grouped_geoms[fid] = [geom]
                props_by_id[fid] = props
            else:
                grouped_geoms[fid].append(geom)

    building_ids: list[str] = []
    building_geoms_deg: list[Any] = []
    building_geoms_m: list[Any] = []

    for fid, geoms in grouped_geoms.items():
        merged = geoms[0] if len(geoms) == 1 else unary_union(geoms)
        poly = coerce_polygonal(merged)
        if poly is None:
            continue
        building_ids.append(fid)
        building_geoms_deg.append(poly)
        building_geoms_m.append(geom_to_meters(poly))

    print(f"Loaded {raw_rows} tile rows -> {len(building_ids)} stitched unique buildings.")
    return building_ids, building_geoms_deg, building_geoms_m, props_by_id


def load_landuse_polygons(base_pmtiles_path: Path, tmp_dir: Path) -> list[tuple[float, str, Any]]:
    """Extract and stitch OSM/Overture land_use polygons from bacolod_base.pmtiles."""
    if not base_pmtiles_path.exists():
        print(f"Base PMTiles not found at {base_pmtiles_path}; skipping land-use fallback.")
        return []

    extracted = tmp_dir / "extracted_base.geojsonl"
    print(f"Extracting land_use polygons from {base_pmtiles_path}...")
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

    grouped_geoms: dict[str, list[Any]] = {}
    class_by_id: dict[str, str] = {}

    with extracted.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            props = feat.get("properties") or {}
            if props.get("kind") != "land_use":
                continue
            raw_bclass = str(props.get("bclass") or "").lower().strip()
            mapped = LANDUSE_CLASS_MAP.get(raw_bclass)
            if not mapped:
                continue
            fid = str(props.get("id") or "")
            if not fid:
                continue
            geom = shape(feat["geometry"])
            grouped_geoms.setdefault(fid, []).append(geom)
            class_by_id[fid] = mapped

    lu_items: list[tuple[float, str, Any]] = []
    for fid, geoms in grouped_geoms.items():
        merged = geoms[0] if len(geoms) == 1 else unary_union(geoms)
        poly = coerce_polygonal(merged)
        if poly is None:
            continue
        poly_m = geom_to_meters(poly)
        lu_items.append((float(poly_m.area), class_by_id[fid], poly_m))

    lu_items.sort(key=lambda item: item[0])
    print(f"Loaded {len(lu_items)} stitched land_use polygons for classification fallback.")
    return lu_items


def _backfill_missing_orig_bclass_from_overture(
    building_props: dict[str, dict[str, Any]],
) -> None:
    """Recover original Overture bclass/name when re-running on enriched PMTiles.

    Earlier runs wrote POI-derived classes and names straight into `bclass`/`name`,
    so a re-run cannot tell them apart from source data. `orig_name` is stored as ""
    when the source building had no name (None would be dropped by ogr2ogr).
    """
    needs_recovery = any(
        ("orig_bclass" not in p and "class_source" in p) or "orig_name" not in p
        for p in building_props.values()
    )
    if not needs_recovery:
        return

    print("Recovering missing orig_bclass/orig_name values from Overture S3 for idempotency...")
    try:
        try:
            from scripts.fetch_bacolod import (
                OVERTURE_RELEASE,
                S3_BASE,
            overture_path,
                bbox_where,
                create_duckdb_connection,
            )
        except ImportError:
            from fetch_bacolod import (  # type: ignore[no-redef]
                OVERTURE_RELEASE,
                S3_BASE,
            overture_path,
                bbox_where,
                create_duckdb_connection,
            )

        con = create_duckdb_connection()
        b_path = overture_path("buildings", "building")
        bp_path = overture_path("buildings", "building_part")
        rows = con.execute(
            f"""
            SELECT id, COALESCE(NULLIF(LOWER(TRIM(class)), ''), 'unknown') AS bclass,
                   names.primary AS name
            FROM read_parquet('{b_path}')
            WHERE {bbox_where()}
            UNION ALL
            SELECT bp.id, COALESCE(NULLIF(LOWER(TRIM(b.class)), ''), 'unknown') AS bclass,
                   COALESCE(bp.names.primary, b.names.primary) AS name
            FROM read_parquet('{bp_path}') bp
            LEFT JOIN read_parquet('{b_path}') b
              ON bp.building_id = b.id AND {bbox_where('b')}
            WHERE {bbox_where('bp')}
            """
        ).fetchall()
        overture_classes = {str(fid): str(cls or "unknown") for fid, cls, _ in rows}
        overture_names = {str(fid): str(name or "").strip() for fid, _, name in rows}
        recovered = 0
        names_recovered = 0
        for fid, props in building_props.items():
            if "orig_bclass" not in props and fid in overture_classes:
                props["orig_bclass"] = overture_classes[fid]
                recovered += 1
            if "orig_name" not in props:
                # Non-Overture footprints (Google / Microsoft) carry no source name.
                props["orig_name"] = overture_names.get(fid, "")
                names_recovered += 1
        print(
            f"Recovered orig_bclass for {recovered:,} and orig_name for {names_recovered:,} "
            f"buildings from Overture {OVERTURE_RELEASE}."
        )
    except Exception as exc:
        print(f"Could not query Overture S3 for orig_bclass recovery ({exc}); using fallback.")


def build_building_pois_and_labels(
    building_ids: list[str],
    building_geoms_deg: list[Any],
    building_props: dict[str, dict[str, Any]],
    building_matches: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Build lean per-building POI feature dictionary and floating z16+ label GeoJSON."""
    building_pois: dict[str, dict[str, Any]] = {}
    label_features: list[dict[str, Any]] = []

    for bid, geom_deg in zip(building_ids, building_geoms_deg):
        matched = building_matches.get(bid)
        if not matched:
            continue

        props = building_props[bid]
        sorted_matched = sorted(
            matched,
            key=lambda p: (
                0 if p.get("match_method") == "inside" else 1,
                TRUST_SORT_RANK.get(str(p.get("trust") or "unrated"), 1),
                SOURCE_TRUST_RANK.get(str(p.get("source") or "osm"), 99),
                float(p.get("match_distance_m") or 0.0),
                -float(p.get("confidence") or 0.0),
                -int(p.get("priority") or 0),
                str(p.get("name") or ""),
            ),
        )

        # Second safety net: deduplicate identical normalized names within the same building
        deduped_items: list[dict[str, Any]] = []
        seen_norms: list[str] = []
        for p in sorted_matched:
            norm = normalize_place_name(p.get("name"))
            if norm and any(_names_match(norm, existing) for existing in seen_norms):
                continue
            if norm:
                seen_norms.append(norm)
            deduped_items.append(p)

        poi_items: list[dict[str, Any]] = []
        first_named: str | None = None
        for p in deduped_items:
            src = str(p.get("source") or "osm")
            if (
                first_named is None
                and p.get("name")
                and (src == "osm" or p.get("trust") != "unverified")
            ):
                first_named = str(p["name"])
            item: dict[str, Any] = {
                "osm_id": p["osm_id"],
                "category": p["category"],
                "poi_key": p["poi_key"],
                "poi_value": p["poi_value"],
                "match_method": p["match_method"],
                "match_distance_m": p["match_distance_m"],
                "source": src,
            }
            if p.get("name"):
                item["name"] = p["name"]
            if p.get("mapped_bclass"):
                item["mapped_bclass"] = p["mapped_bclass"]
            if src != "osm" and p.get("confidence") is not None:
                item["confidence"] = p["confidence"]
            for opt_key in ("brand", "cuisine", "addr_street", "website", "phone"):
                if p.get(opt_key):
                    item[opt_key] = p[opt_key]
            if src != "osm" and p.get("updated"):
                item["updated"] = p["updated"]
            if p.get("vote_score") is not None:
                item["vote_score"] = p["vote_score"]
            if p.get("trust"):
                item["trust"] = p["trust"]
            if p.get("votes") is not None:
                item["votes"] = p["votes"]
            poi_items.append(item)

        rep_pt = geom_deg.representative_point()
        center = [round(float(rep_pt.x), 6), round(float(rep_pt.y), 6)]
        primary_name = (
            str(props["name"]).strip()
            if isinstance(props.get("name"), str) and props["name"].strip()
            else first_named
        )
        label = format_building_label(primary_name, len(poi_items))

        record: dict[str, Any] = {
            "id": bid,
            "center": center,
            "bclass": props.get("bclass", "unknown"),
            "class_source": props.get("class_source", "unknown"),
            "class_confidence": props.get("class_confidence", "unknown"),
            "poi_count": len(poi_items),
            "pois": poi_items,
        }
        for opt_field in (
            "name",
            "effective_height",
            "height_source",
            "num_floors",
            "area_m2",
            "primary_source",
        ):
            val = props.get(opt_field)
            if val is not None and val != "":
                record[opt_field] = val
        if label:
            record["label"] = label
        building_pois[bid] = record

        if label:
            label_props: dict[str, Any] = {
                "id": bid,
                "label": label,
                "bclass": props.get("bclass", "unknown"),
                "class_source": props.get("class_source", "unknown"),
                "poi_count": len(poi_items),
            }
            for opt_field in ("name", "effective_height", "height_source", "area_m2"):
                val = props.get(opt_field)
                if val is not None and val != "":
                    label_props[opt_field] = val
            label_features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": center},
                    "properties": label_props,
                }
            )

    labels_fc = {"type": "FeatureCollection", "features": label_features}
    return building_pois, labels_fc


def write_building_pois_and_labels(
    building_pois: dict[str, dict[str, Any]],
    labels_fc: dict[str, Any],
    out_building_pois_path: Path,
    out_labels_path: Path,
) -> None:
    """Atomically write building_pois.json and building_labels.geojson."""
    tmp_pois = out_building_pois_path.with_suffix(".json.tmp")
    tmp_pois.write_text(json.dumps(building_pois, separators=(",", ":")), encoding="utf-8")
    tmp_pois.replace(out_building_pois_path)

    tmp_labels = out_labels_path.with_suffix(".geojson.tmp")
    tmp_labels.write_text(json.dumps(labels_fc, separators=(",", ":")), encoding="utf-8")
    tmp_labels.replace(out_labels_path)

    print(
        f"Wrote {len(building_pois):,} buildings with POIs -> {out_building_pois_path} "
        f"({out_building_pois_path.stat().st_size / 1024:.1f} KB)"
    )
    print(
        f"Wrote {len(labels_fc['features']):,} floating building labels -> {out_labels_path} "
        f"({out_labels_path.stat().st_size / 1024:.1f} KB)"
    )


def rebuild_buildings_pmtiles(
    building_ids: list[str],
    building_geoms_deg: list[Any],
    building_props: dict[str, dict[str, Any]],
    pmtiles_path: Path,
    tmp_dir: Path,
) -> dict[str, int]:
    """Serialize enriched buildings to GeoJSONSeq and atomically compile PMTiles."""
    enriched_geojsonl = tmp_dir / "enriched_buildings.geojsonl"
    height_counts = {"measured": 0, "floors": 0, "estimated": 0}

    with enriched_geojsonl.open("w", encoding="utf-8") as fh:
        for bid, geom_deg in zip(building_ids, building_geoms_deg):
            props = building_props[bid]
            h_src = str(props.get("height_source") or "estimated")
            height_counts[h_src] = height_counts.get(h_src, 0) + 1

            # Ensure all properties are flat scalars for MVT encoding
            clean_props: dict[str, Any] = {}
            for k, v in props.items():
                if v is None or isinstance(v, (str, int, float, bool)):
                    clean_props[k] = v
                else:
                    clean_props[k] = json.dumps(v)

            feat = {
                "type": "Feature",
                "geometry": mapping(geom_deg),
                "properties": clean_props,
            }
            fh.write(json.dumps(feat, separators=(",", ":")) + "\n")

    tmp_pmtiles = tmp_dir / f"{PLACE.file_prefix}_buildings.pmtiles"
    cmd = [
        "ogr2ogr",
        "-f",
        "PMTiles",
        "-nln",
        "buildings",
        "-dsco",
        "MINZOOM=11",
        "-dsco",
        "MAXZOOM=16",
        "-t_srs",
        "EPSG:4326",
        str(tmp_pmtiles),
        str(enriched_geojsonl),
    ]
    print(f"Rebuilding PMTiles: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    tmp_pmtiles.replace(pmtiles_path)
    return height_counts


def enrich_buildings_with_osm(
    pmtiles_path: Path = DEFAULT_BUILDINGS_PMTILES,
    base_pmtiles_path: Path = DEFAULT_BASE_PMTILES,
    roads_pmtiles_path: Path = DEFAULT_ROADS_PMTILES,
    boundaries_path: Path = DEFAULT_BOUNDARIES,
    out_building_pois_path: Path = DEFAULT_OUT_BUILDING_POIS,
    out_labels_path: Path = DEFAULT_OUT_LABELS,
    manifest_path: Path = DEFAULT_MANIFEST,
    max_distance_m: float = 30.0,
    cached_osm_path: Path | None = None,
    cached_compounds_path: Path | None = None,
    include_osm_compounds: bool = True,
    include_overture_places: bool = True,
    overture_min_confidence: float = 0.65,
    overture_min_update_year: int = OVERTURE_MIN_UPDATE_YEAR,
    foursquare_parquet: str | None = None,
) -> dict[str, Any]:
    """Run the full multi-source POI pull -> deduplicate -> score/validate -> nearest-building match -> classification -> PMTiles pipeline."""
    if not pmtiles_path.exists():
        raise FileNotFoundError(f"Buildings PMTiles not found: {pmtiles_path}")

    if cached_osm_path is not None and cached_osm_path.exists():
        print(f"Loading cached OSM elements from {cached_osm_path}...")
        raw_elements = json.loads(cached_osm_path.read_text(encoding="utf-8"))
        if isinstance(raw_elements, dict):
            raw_elements = raw_elements.get("elements", [])
    else:
        raw_elements = fetch_osm_pois()
        if cached_osm_path is not None:
            cached_osm_path.write_text(json.dumps(raw_elements), encoding="utf-8")

    osm_pois = normalize_osm_elements(raw_elements)
    print(f"Normalized {len(osm_pois):,} OSM POIs (from {len(raw_elements):,} raw elements).")

    all_pois: list[dict[str, Any]] = list(osm_pois)
    if include_overture_places:
        overture_pois = fetch_overture_places(
            min_confidence=overture_min_confidence,
            min_update_year=overture_min_update_year,
        )
        all_pois.extend(overture_pois)
    if foursquare_parquet:
        fsq_pois = load_foursquare_places(
            foursquare_parquet,
            min_refresh_year=overture_min_update_year,
        )
        all_pois.extend(fsq_pois)

    all_pois, unreliable = filter_unreliable_places(all_pois)
    print(
        f"Dropped {sum(unreliable.values()):,} third-party places with untrustworthy "
        f"coordinates: {dict(unreliable)}"
    )

    pois = deduplicate_pois(all_pois, radius_m=35.0)
    poi_sources_total = collections.Counter(str(p.get("source") or "osm") for p in pois)
    print(
        f"Cross-source deduplication: {len(all_pois):,} raw -> {len(pois):,} unique POIs "
        f"({dict(poi_sources_total)})"
    )

    try:
        from scripts.score_poi_votes import (
            load_barangay_geometries,
            road_geometries,
            score_flat_pois,
        )
    except ImportError:
        from score_poi_votes import (  # type: ignore[no-redef]
            load_barangay_geometries,
            road_geometries,
            score_flat_pois,
        )

    roads = road_geometries(roads_pmtiles_path) if roads_pmtiles_path.exists() else {}
    brgy_geoms_m, named_aliases = (
        load_barangay_geometries(boundaries_path) if boundaries_path.exists() else ({}, {})
    )
    score_flat_pois(pois, roads, brgy_geoms_m, named_aliases)
    pois, wrong_brgy_dropped = filter_wrong_barangay_pois(pois)
    poi_sources_total = collections.Counter(str(p.get("source") or "osm") for p in pois)
    poi_trust_counts = collections.Counter(str(p.get("trust") or "unrated") for p in pois)
    print(
        f"POI voting & barangay check: dropped {wrong_brgy_dropped:,} third-party places with "
        f"wrong-barangay address | trust={dict(poi_trust_counts)} | sources={dict(poi_sources_total)}"
    )

    compound_items: list[tuple[float, str, Any]] = []
    extra_landuse_items: list[tuple[float, str, Any]] = []
    if include_osm_compounds:
        if cached_compounds_path is not None and cached_compounds_path.exists():
            raw_compounds = json.loads(cached_compounds_path.read_text(encoding="utf-8"))
            if isinstance(raw_compounds, dict):
                raw_compounds = raw_compounds.get("elements", [])
        else:
            raw_compounds = fetch_osm_compounds()
            if cached_compounds_path is not None and raw_compounds:
                cached_compounds_path.write_text(json.dumps(raw_compounds), encoding="utf-8")
        compound_items, extra_landuse_items = parse_osm_compounds(raw_compounds)
        print(
            f"Parsed {len(compound_items):,} OSM compound polygons and "
            f"{len(extra_landuse_items):,} extra OSM landuse polygons."
        )

    with tempfile.TemporaryDirectory(prefix=f"{PLACE.slug}_osm_") as tmp:
        tmp_dir = Path(tmp)
        building_ids, building_geoms_deg, building_geoms_m, building_props = load_stitched_buildings(
            pmtiles_path, tmp_dir
        )
        _backfill_missing_orig_bclass_from_overture(building_props)
        landuse_items = load_landuse_polygons(base_pmtiles_path, tmp_dir) + extra_landuse_items
        arterial_roads_m = load_roads_by_tier(roads_pmtiles_path, tmp_dir)

        pois, building_matches = match_pois_to_buildings(
            pois, building_ids, building_geoms_m, max_distance_m=max_distance_m
        )

        matched_inside = sum(1 for p in pois if p["match_method"] == "inside")
        matched_nearest = sum(1 for p in pois if p["match_method"] == "nearest")
        unmatched = sum(1 for p in pois if p["match_method"] == "unmatched")
        matched_sources = collections.Counter(
            str(p.get("source") or "osm") for p in pois if p["match_method"] != "unmatched"
        )
        print(
            f"POI match results (<= {max_distance_m:.0f}m): "
            f"inside={matched_inside:,}, nearest={matched_nearest:,}, unmatched={unmatched:,} "
            f"| matched by source: {dict(matched_sources)}"
        )

        stats = classify_buildings(
            building_ids=building_ids,
            building_geoms_m=building_geoms_m,
            building_props=building_props,
            building_matches=building_matches,
            landuse_items=landuse_items,
            compound_items=compound_items,
            arterial_roads_m=arterial_roads_m,
        )

        building_pois, labels_fc = build_building_pois_and_labels(
            building_ids=building_ids,
            building_geoms_deg=building_geoms_deg,
            building_props=building_props,
            building_matches=building_matches,
        )
        write_building_pois_and_labels(
            building_pois, labels_fc, out_building_pois_path, out_labels_path
        )
        height_counts = rebuild_buildings_pmtiles(
            building_ids=building_ids,
            building_geoms_deg=building_geoms_deg,
            building_props=building_props,
            pmtiles_path=pmtiles_path,
            tmp_dir=tmp_dir,
        )

    total_buildings = len(building_ids)
    after_bclass: collections.Counter[str] = stats["after_bclass"]
    before_bclass: collections.Counter[str] = stats["before_bclass"]
    class_sources: collections.Counter[str] = stats["class_sources"]
    class_confidence: collections.Counter[str] = stats["class_confidence"]

    buildings_classified = total_buildings - after_bclass.get("unknown", 0)
    buildings_commercial = sum(after_bclass.get(cls, 0) for cls in COMMERCIAL_CLASSES)
    buildings_mixed_use = after_bclass.get("mixed_use", 0)
    buildings_with_pois = len(building_pois)
    before_commercial = sum(before_bclass.get(cls, 0) for cls in COMMERCIAL_CLASSES)

    print("\n--- Classification Summary ---")
    print(f"Total unique buildings: {total_buildings:,}")
    print(f"Commercial/retail/office/hotel/mixed-use: {before_commercial:,} -> {buildings_commercial:,} (mixed_use: {buildings_mixed_use:,})")
    print(f"Buildings with attached POIs: {buildings_with_pois:,}")
    print(f"Total classified (non-unknown): {total_buildings - before_bclass.get('unknown', 0):,} -> {buildings_classified:,}")
    print(f"Heights re-estimated: {stats['height_reestimated']:,}, Names backfilled: {stats['names_backfilled']:,}")
    print(f"Class sources: {dict(class_sources)}")
    print(f"Class confidence: {dict(class_confidence)}")
    print(f"Top 20 classes after enrichment: {after_bclass.most_common(20)}")

    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
        counts = manifest.setdefault("counts", {})
        counts["buildings"] = total_buildings
        counts["buildings_measured"] = height_counts.get("measured", 0)
        counts["buildings_floors"] = height_counts.get("floors", 0)
        counts["buildings_estimated"] = height_counts.get("estimated", 0)
        counts["pois_total"] = len(pois)
        counts["pois_matched"] = matched_inside + matched_nearest
        counts["poi_sources"] = dict(matched_sources)
        counts["osm_pois"] = poi_sources_total.get("osm", 0)
        counts["osm_pois_matched"] = matched_sources.get("osm", 0)
        counts["buildings_with_pois"] = buildings_with_pois
        counts["buildings_classified"] = buildings_classified
        counts["buildings_commercial"] = buildings_commercial
        counts["buildings_mixed_use"] = buildings_mixed_use
        counts["class_sources"] = dict(class_sources)
        counts["class_confidence"] = dict(class_confidence)
        files = manifest.setdefault("files", {})
        files.pop("osm_pois", None)
        files["building_pois"] = f"{PLACE.data_url_dir}/building_pois.json"
        files["building_labels"] = f"{PLACE.data_url_dir}/building_labels.geojson"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"Updated manifest -> {manifest_path}")

    return {
        "total_buildings": total_buildings,
        "pois_total": len(pois),
        "pois_matched": matched_inside + matched_nearest,
        "poi_sources": dict(matched_sources),
        "buildings_with_pois": buildings_with_pois,
        "buildings_classified": buildings_classified,
        "buildings_commercial": buildings_commercial,
        "buildings_mixed_use": buildings_mixed_use,
        "class_sources": dict(class_sources),
        "class_confidence": dict(class_confidence),
        "after_bclass": dict(after_bclass),
    }


def parse_args() -> argparse.Namespace:
    from place import add_place_argument

    parser = argparse.ArgumentParser(
        description="Enrich the place's buildings with OSM, Overture, and Foursquare POIs via nearest-building matching."
    )
    parser.add_argument("--pmtiles", type=Path, default=DEFAULT_BUILDINGS_PMTILES)
    parser.add_argument("--base-pmtiles", type=Path, default=DEFAULT_BASE_PMTILES)
    parser.add_argument("--roads-pmtiles", type=Path, default=DEFAULT_ROADS_PMTILES)
    parser.add_argument("--boundaries", type=Path, default=DEFAULT_BOUNDARIES)
    parser.add_argument("--out-building-pois", type=Path, default=DEFAULT_OUT_BUILDING_POIS)
    parser.add_argument("--out-labels", type=Path, default=DEFAULT_OUT_LABELS)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--max-distance-m", type=float, default=30.0)
    parser.add_argument("--cached-osm", type=Path, default=None)
    parser.add_argument("--cached-compounds", type=Path, default=None)
    parser.add_argument("--no-osm-compounds", action="store_true")
    parser.add_argument("--no-overture-places", action="store_true")
    parser.add_argument("--overture-min-confidence", type=float, default=0.65)
    parser.add_argument("--overture-min-update-year", type=int, default=OVERTURE_MIN_UPDATE_YEAR)
    parser.add_argument("--foursquare-parquet", type=str, default=None)
    add_place_argument(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    enrich_buildings_with_osm(
        pmtiles_path=args.pmtiles,
        base_pmtiles_path=args.base_pmtiles,
        roads_pmtiles_path=args.roads_pmtiles,
        boundaries_path=args.boundaries,
        out_building_pois_path=args.out_building_pois,
        out_labels_path=args.out_labels,
        manifest_path=args.manifest,
        max_distance_m=args.max_distance_m,
        cached_osm_path=args.cached_osm,
        cached_compounds_path=args.cached_compounds,
        include_osm_compounds=not args.no_osm_compounds,
        include_overture_places=not args.no_overture_places,
        overture_min_confidence=args.overture_min_confidence,
        overture_min_update_year=args.overture_min_update_year,
        foursquare_parquet=args.foursquare_parquet,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
