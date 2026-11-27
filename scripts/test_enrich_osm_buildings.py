#!/usr/bin/env python3
"""Unit tests for OSM POI classification, mixed-use resolution, nearest-building matching, and building outputs."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from shapely.geometry import LineString, box

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from enrich_osm_buildings import (  # noqa: E402
    build_building_pois_and_labels,
    classify_building_name,
    classify_buildings,
    classify_foursquare_labels,
    classify_osm_tags,
    classify_overture_place,
    deduplicate_pois,
    filter_unreliable_places,
    filter_wrong_barangay_pois,
    format_building_label,
    geom_to_meters,
    match_pois_to_buildings,
    normalize_osm_elements,
    parse_osm_compounds,
    resolve_poi_building_class,
)


class TestOsmClassification(unittest.TestCase):
    def test_classify_osm_tags_commercial_retail_and_services(self) -> None:
        mall = classify_osm_tags({"shop": "mall", "name": "SM City Bacolod"})
        assert mall is not None
        self.assertEqual(mall["mapped_bclass"], "retail")
        self.assertEqual(mall["category"], "retail")
        self.assertTrue(mall["building_applicable"])

        cafe = classify_osm_tags({"amenity": "restaurant", "name": "Calea"})
        assert cafe is not None
        self.assertEqual(cafe["mapped_bclass"], "commercial")
        self.assertEqual(cafe["category"], "food")
        self.assertTrue(cafe["building_applicable"])

        bank = classify_osm_tags({"amenity": "bank", "name": "BPI"})
        assert bank is not None
        self.assertEqual(bank["mapped_bclass"], "commercial")
        self.assertEqual(bank["category"], "commercial")
        self.assertTrue(bank["building_applicable"])

        office = classify_osm_tags({"office": "company", "name": "Negros Corp"})
        assert office is not None
        self.assertEqual(office["mapped_bclass"], "office")
        self.assertEqual(office["category"], "office")
        self.assertTrue(office["building_applicable"])

        hotel = classify_osm_tags({"tourism": "hotel", "name": "L'Fisher Hotel"})
        assert hotel is not None
        self.assertEqual(hotel["mapped_bclass"], "hotel")
        self.assertEqual(hotel["category"], "hotel")
        self.assertTrue(hotel["building_applicable"])

    def test_classify_osm_tags_civic_health_industrial_and_outdoor(self) -> None:
        school = classify_osm_tags({"amenity": "school"})
        assert school is not None
        self.assertEqual(school["mapped_bclass"], "school")

        hosp = classify_osm_tags({"healthcare": "hospital"})
        assert hosp is not None
        self.assertEqual(hosp["mapped_bclass"], "hospital")

        church = classify_osm_tags({"amenity": "place_of_worship"})
        assert church is not None
        self.assertEqual(church["mapped_bclass"], "religious")

        ind = classify_osm_tags({"industrial": "warehouse"})
        assert ind is not None
        self.assertEqual(ind["mapped_bclass"], "industrial")

        for tags in (
            {"amenity": "parking"},
            {"leisure": "park"},
            {"amenity": "bench"},
        ):
            res = classify_osm_tags(tags)
            assert res is not None
            self.assertIsNone(res["mapped_bclass"])
            self.assertFalse(res["building_applicable"])

    def test_normalize_filters_unnamed_micro_noise_only(self) -> None:
        elements = [
            {"type": "node", "id": 1, "lon": 122.95, "lat": 10.67, "tags": {"amenity": "bench"}},
            {
                "type": "node",
                "id": 2,
                "lon": 122.95,
                "lat": 10.67,
                "tags": {"leisure": "pitch"},
            },
            {
                "type": "node",
                "id": 3,
                "lon": 122.95,
                "lat": 10.67,
                "tags": {"leisure": "park", "name": "Bacolod Public Plaza"},
            },
            {
                "type": "way",
                "id": 4,
                "center": {"lon": 122.951, "lat": 10.671},
                "tags": {"shop": "bakery"},
            },
        ]
        pois = normalize_osm_elements(elements)
        ids = [p["osm_id"] for p in pois]
        self.assertEqual(ids, ["node/3", "way/4"])

    def test_mixed_use_and_hotel_food_rules(self) -> None:
        # Shophouse: residential house with inside cafe -> mixed_use
        shophouse_pois = [
            {
                "mapped_bclass": "commercial",
                "category": "food",
                "building_applicable": True,
                "match_method": "inside",
                "match_distance_m": 0.0,
                "priority": 85,
            }
        ]
        self.assertEqual(resolve_poi_building_class(shophouse_pois, "house"), "mixed_use")

        # Multi-tenant building: retail + office -> mixed_use
        multi_pois = [
            {
                "mapped_bclass": "retail",
                "category": "retail",
                "building_applicable": True,
                "match_method": "inside",
                "match_distance_m": 0.0,
                "priority": 90,
            },
            {
                "mapped_bclass": "office",
                "category": "office",
                "building_applicable": True,
                "match_method": "inside",
                "match_distance_m": 0.0,
                "priority": 85,
            },
        ]
        self.assertEqual(resolve_poi_building_class(multi_pois, "unknown"), "mixed_use")

        # Hotel + in-house restaurant stays hotel
        hotel_pois = [
            {
                "mapped_bclass": "hotel",
                "category": "hotel",
                "building_applicable": True,
                "match_method": "inside",
                "match_distance_m": 0.0,
                "priority": 92,
            },
            {
                "mapped_bclass": "commercial",
                "category": "food",
                "building_applicable": True,
                "match_method": "inside",
                "match_distance_m": 0.0,
                "priority": 85,
            },
        ]
        self.assertEqual(resolve_poi_building_class(hotel_pois, "unknown"), "hotel")

    def test_format_building_label(self) -> None:
        self.assertEqual(format_building_label("Calea", 1), "Calea")
        self.assertEqual(format_building_label("SM City Bacolod", 3), "SM City Bacolod (+2)")
        self.assertIsNone(format_building_label(None, 2))

    def test_classify_overture_place(self) -> None:
        food = classify_overture_place("restaurant", "restaurant", "food_and_drink")
        assert food is not None
        self.assertEqual(food["mapped_bclass"], "commercial")
        self.assertEqual(food["category"], "food")

        retail = classify_overture_place("supermarket", "supermarket", "shopping")
        assert retail is not None
        self.assertEqual(retail["mapped_bclass"], "retail")

        office = classify_overture_place("real_estate_service", "real_estate_service", "services_and_business")
        assert office is not None
        self.assertEqual(office["mapped_bclass"], "office")

        hotel = classify_overture_place("hotel", "hotel", "lodging")
        assert hotel is not None
        self.assertEqual(hotel["mapped_bclass"], "hotel")

        hosp = classify_overture_place("hospital", "hospital", "health_care")
        assert hosp is not None
        self.assertEqual(hosp["mapped_bclass"], "hospital")

        school = classify_overture_place("elementary_school", "elementary_school", "education")
        assert school is not None
        self.assertEqual(school["mapped_bclass"], "school")

        church = classify_overture_place("christian_place_of_worship", "christian_place_of_worship", "cultural_and_historic")
        assert church is not None
        self.assertEqual(church["mapped_bclass"], "religious")

        ind = classify_overture_place("warehouse", "warehouse", "services_and_business")
        assert ind is not None
        self.assertEqual(ind["mapped_bclass"], "industrial")

        # Geographic entities and outdoor parks must not reclassify buildings
        self.assertIsNone(classify_overture_place("beach", "beach", "geographic_entities"))
        park = classify_overture_place("park", "park", "sports_and_recreation")
        assert park is not None
        self.assertFalse(park["building_applicable"])

    def test_classify_foursquare_labels(self) -> None:
        dining = classify_foursquare_labels(["Dining and Drinking > Cafe"])
        assert dining is not None
        self.assertEqual(dining["mapped_bclass"], "commercial")

        retail = classify_foursquare_labels(["Retail > Supermarket"])
        assert retail is not None
        self.assertEqual(retail["mapped_bclass"], "retail")

        office = classify_foursquare_labels(["Business and Professional Services > Real Estate Office"])
        assert office is not None
        self.assertEqual(office["mapped_bclass"], "office")

        hosp = classify_foursquare_labels(["Health and Medicine > Hospital"])
        assert hosp is not None
        self.assertEqual(hosp["mapped_bclass"], "hospital")

        school = classify_foursquare_labels(["Community and Government > Education > High School"])
        assert school is not None
        self.assertEqual(school["mapped_bclass"], "school")

        park = classify_foursquare_labels(["Landmarks and Outdoors > Park"])
        assert park is not None
        self.assertFalse(park["building_applicable"])

    def test_deduplicate_pois_prefers_osm_and_merges_metadata(self) -> None:
        osm_poi = {
            "osm_id": "node/1",
            "source": "osm",
            "confidence": 1.0,
            "priority": 90,
            "name": "Calea Pastries & Coffee",
            "lon": 122.9500,
            "lat": 10.6700,
            "phone": None,
            "website": None,
            "brand": None,
            "addr_street": None,
        }
        ovt_dup = {
            "osm_id": "ovt/abc",
            "source": "overture",
            "confidence": 0.92,
            "priority": 75,
            "name": "Calea Pastries & Coffee Bacolod",
            "lon": 122.9501,
            "lat": 10.67005,
            "phone": "+63341234567",
            "website": "https://calea.example",
            "brand": "Calea",
            "addr_street": "15th Lacson St",
        }
        ovt_distinct = {
            "osm_id": "ovt/xyz",
            "source": "overture",
            "confidence": 0.85,
            "priority": 75,
            "name": "BDO Unibank",
            "lon": 122.9501,
            "lat": 10.67005,
        }
        deduped = deduplicate_pois([ovt_dup, osm_poi, ovt_distinct], radius_m=35.0)
        self.assertEqual(len(deduped), 2)
        kept_calea = next(p for p in deduped if p["osm_id"] == "node/1")
        self.assertEqual(kept_calea["phone"], "+63341234567")
        self.assertEqual(kept_calea["website"], "https://calea.example")

    def test_deduplicate_pois_merges_misplaced_copy_by_specific_phone(self) -> None:
        # Real case: Overture put "Apollo Restaurant Hilado" ~850 m east, in Villamonte.
        osm_poi = {"osm_id": "node/3360966921", "source": "osm", "confidence": 1.0, "priority": 90,
                   "name": "Apollo Restaurant", "lon": 122.956387, "lat": 10.671322, "phone": None}
        # Correctly placed Overture copy next to the OSM pin: supplies the phone via backfill.
        near_copy = {"osm_id": "ovt/near", "source": "overture", "confidence": 0.85, "priority": 75,
                     "name": "Apollo Restaurant", "lon": 122.956339, "lat": 10.671249,
                     "phone": "+639616036774"}
        misplaced = {"osm_id": "ovt/hilado", "source": "overture", "confidence": 0.95, "priority": 75,
                     "name": "Apollo Restaurant Hilado - Capitol Shopping", "lon": 122.96405, "lat": 10.67177,
                     "phone": "0961 603 6774"}
        other_branch = {"osm_id": "ovt/east", "source": "overture", "confidence": 0.86, "priority": 75,
                        "name": "Apollo Restaurant Lopues' East Centre", "lon": 122.97102, "lat": 10.67176,
                        "phone": "+639432841089"}
        deduped = deduplicate_pois([misplaced, near_copy, osm_poi, other_branch])
        self.assertEqual(sorted(p["osm_id"] for p in deduped), ["node/3360966921", "ovt/east"])

    def test_deduplicate_pois_ignores_shared_chain_hotline(self) -> None:
        branches = [
            {"osm_id": f"ovt/jb{i}", "source": "overture", "confidence": 0.9, "priority": 75,
             "name": "Jollibee", "lon": 122.95 + i * 0.005, "lat": 10.67, "phone": "+63 34 433 0000"}
            for i in range(4)
        ]
        self.assertEqual(len(deduplicate_pois(branches)), 4)
        # Metro Manila (02) hotline shared by just two branches is still not a match.
        mcdo = [
            {"osm_id": f"ovt/mc{i}", "source": "overture", "confidence": 0.9, "priority": 75,
             "name": "McDonald's", "lon": 122.95 + i * 0.01, "lat": 10.67, "phone": "+63288886236"}
            for i in range(2)
        ]
        self.assertEqual(len(deduplicate_pois(mcdo)), 2)

    def test_filter_unreliable_places_drops_stacks_and_out_of_area(self) -> None:
        def ovt(i: str, name: str, lon: float, lat: float) -> dict:
            return {"osm_id": f"ovt/{i}", "source": "overture", "name": name, "lon": lon, "lat": lat}

        stack = [ovt(str(i), n, 122.949766, 10.667934) for i, n in enumerate(
            ["Ludz Mini Mart", "Merkz Hair Extension", "Blue Bottle Purified Water"])]
        pair = [ovt("p1", "Shop A", 122.95, 10.68), ovt("p2", "Shop B", 122.95, 10.68)]
        foreign = [
            ovt("naia", "Ninoy Aquino International Aiport Terminal 2", 122.963173, 10.669179),
            ovt("antipolo", "Antipolo, Pontevedra", 122.930134, 10.626219),
            ovt("sipalay", "Sacred Heart of Jesus Parish - Sipalay", 122.94, 10.66),
        ]
        kept_local = ovt("local", "Solid Manila Building Office", 122.96, 10.66)
        osm_same_point = {"osm_id": "node/9", "source": "osm", "name": "Stacked OSM", "lon": 122.949766, "lat": 10.667934}
        kept, dropped = filter_unreliable_places(stack + pair + foreign + [kept_local, osm_same_point])
        self.assertEqual(sorted(p["osm_id"] for p in kept), ["node/9", "ovt/local", "ovt/p1", "ovt/p2"])
        self.assertEqual(dropped["stacked_geocode"], 3)
        self.assertEqual(dropped["out_of_area"], 3)

    def test_classify_buildings_resets_stale_poi_names_on_rerun(self) -> None:
        ids = ["stale", "named"]
        geoms = [geom_to_meters(box(122.95, 10.67, 122.9502, 10.6702)),
                 geom_to_meters(box(122.96, 10.67, 122.9602, 10.6702))]
        base = {"bclass": "unknown", "orig_bclass": "unknown", "height_source": "estimated", "area_m2": 100.0}
        props = {
            # Name baked in from a POI that a later run no longer matches here.
            "stale": {**base, "id": "stale", "name": "Apollo Restaurant Hilado", "orig_name": ""},
            "named": {**base, "id": "named", "name": "Old POI Name", "orig_name": "Capitol Building"},
        }
        classify_buildings(building_ids=ids, building_geoms_m=geoms, building_props=props,
                           building_matches={}, landuse_items=[])
        self.assertNotIn("name", props["stale"])
        self.assertEqual(props["named"]["name"], "Capitol Building")

    def test_multisource_provenance_and_confidence_gate(self) -> None:
        b_ids = ["b-house-low", "b-house-high", "b-ovt-near"]
        b_geoms_deg = [
            box(122.9500, 10.6700, 122.9502, 10.6702),
            box(122.9520, 10.6720, 122.9522, 10.6722),
            box(122.9540, 10.6740, 122.9542, 10.6742),
        ]
        b_geoms_m = [geom_to_meters(g) for g in b_geoms_deg]
        b_props = {
            "b-house-low": {"id": "b-house-low", "bclass": "house", "height_source": "estimated", "area_m2": 150.0},
            "b-house-high": {"id": "b-house-high", "bclass": "house", "height_source": "estimated", "area_m2": 150.0},
            "b-ovt-near": {"id": "b-ovt-near", "bclass": "unknown", "height_source": "estimated", "area_m2": 200.0},
        }
        pois = [
            # Low confidence Overture inside house -> overrides to commercial, NOT mixed_use
            {
                "osm_id": "ovt/low",
                "source": "overture",
                "confidence": 0.60,
                "priority": 75,
                "name": "Small Eatery",
                "lon": 122.9501,
                "lat": 10.6701,
                "poi_key": "overture",
                "poi_value": "restaurant",
                "category": "food",
                "mapped_bclass": "commercial",
                "building_applicable": True,
            },
            # High confidence Overture inside house -> promotes to mixed_use
            {
                "osm_id": "ovt/high",
                "source": "overture",
                "confidence": 0.85,
                "priority": 75,
                "name": "Verified Salon",
                "lon": 122.9521,
                "lat": 10.6721,
                "poi_key": "overture",
                "poi_value": "personal_or_beauty_service",
                "category": "commercial",
                "mapped_bclass": "commercial",
                "building_applicable": True,
            },
            # Nearest Overture within 25m of unknown building -> overture_poi_nearest
            {
                "osm_id": "ovt/near",
                "source": "overture",
                "confidence": 0.80,
                "priority": 75,
                "name": "Negros Realty",
                "lon": 122.9543,
                "lat": 10.6741,
                "poi_key": "overture",
                "poi_value": "real_estate_service",
                "category": "office",
                "mapped_bclass": "office",
                "building_applicable": True,
            },
        ]
        _, matches = match_pois_to_buildings(pois, b_ids, b_geoms_m, max_distance_m=30.0)
        classify_buildings(b_ids, b_geoms_m, b_props, matches)

        self.assertEqual(b_props["b-house-low"]["bclass"], "commercial")
        self.assertEqual(b_props["b-house-low"]["class_source"], "overture_poi_inside")
        self.assertEqual(b_props["b-house-high"]["bclass"], "mixed_use")
        self.assertEqual(b_props["b-house-high"]["class_source"], "overture_poi_inside")
        self.assertEqual(b_props["b-ovt-near"]["bclass"], "office")
        self.assertEqual(b_props["b-ovt-near"]["class_source"], "overture_poi_nearest")


class TestNearestBuildingAndClassification(unittest.TestCase):
    def setUp(self) -> None:
        self.b_ids = ["b-shophouse", "b-nearest", "b-landuse", "b-explicit", "b-multi"]
        self.b_geoms_deg = [
            box(122.9500, 10.6700, 122.9502, 10.6702),
            box(122.9505, 10.6700, 122.9507, 10.6702),
            box(122.9520, 10.6720, 122.9522, 10.6722),
            box(122.9540, 10.6740, 122.9542, 10.6742),
            box(122.9560, 10.6760, 122.9562, 10.6762),
        ]
        self.b_geoms_m = [geom_to_meters(g) for g in self.b_geoms_deg]
        self.b_props = {
            "b-shophouse": {
                "id": "b-shophouse",
                "name": None,
                "bclass": "house",
                "height": None,
                "num_floors": None,
                "min_height": 0.0,
                "effective_height": 6.0,
                "height_source": "estimated",
                "area_m2": 480.0,
            },
            "b-nearest": {
                "id": "b-nearest",
                "name": None,
                "bclass": "unknown",
                "height": None,
                "num_floors": 2,
                "min_height": 0.0,
                "effective_height": 6.4,
                "height_source": "floors",
                "area_m2": 480.0,
            },
            "b-landuse": {
                "id": "b-landuse",
                "name": None,
                "bclass": "unknown",
                "height": None,
                "num_floors": None,
                "min_height": 0.0,
                "effective_height": 7.5,
                "height_source": "estimated",
                "area_m2": 300.0,
            },
            "b-explicit": {
                "id": "b-explicit",
                "name": "City School",
                "bclass": "school",
                "height": None,
                "num_floors": None,
                "min_height": 0.0,
                "effective_height": 12.0,
                "height_source": "estimated",
                "area_m2": 480.0,
            },
            "b-multi": {
                "id": "b-multi",
                "name": None,
                "bclass": "unknown",
                "height": None,
                "num_floors": None,
                "min_height": 0.0,
                "effective_height": 7.5,
                "height_source": "estimated",
                "area_m2": 600.0,
            },
        }

    def test_match_classify_outputs_and_idempotency(self) -> None:
        raw_elements = [
            # Inside residential b-shophouse -> mixed_use
            {
                "type": "node",
                "id": 101,
                "lon": 122.9501,
                "lat": 10.6701,
                "tags": {"amenity": "restaurant", "name": "Bacolod Chicken House"},
            },
            # ~11m east of b-nearest -> nearest match within 30m -> retail
            {
                "type": "node",
                "id": 102,
                "lon": 122.9508,
                "lat": 10.6701,
                "tags": {"shop": "supermarket", "name": "Robinsons Supermarket"},
            },
            # Inside b-explicit ('school') -> must NOT override explicit 'school'
            {
                "type": "node",
                "id": 103,
                "lon": 122.9541,
                "lat": 10.6741,
                "tags": {"amenity": "cafe", "name": "Campus Coffee"},
            },
            # Multi-POI retail + office inside b-multi -> mixed_use + label (+1)
            {
                "type": "node",
                "id": 104,
                "lon": 122.9561,
                "lat": 10.6761,
                "tags": {"shop": "convenience", "name": "7-Eleven"},
            },
            {
                "type": "node",
                "id": 105,
                "lon": 122.95615,
                "lat": 10.67615,
                "tags": {"office": "company", "name": "Negros Tech Hub"},
            },
            # > 100m away -> unmatched
            {
                "type": "node",
                "id": 106,
                "lon": 122.9650,
                "lat": 10.6850,
                "tags": {"shop": "convenience", "name": "Far Store"},
            },
        ]
        pois = normalize_osm_elements(raw_elements)
        matched_pois, building_matches = match_pois_to_buildings(
            pois, self.b_ids, self.b_geoms_m, max_distance_m=30.0
        )

        by_id = {p["osm_id"]: p for p in matched_pois}
        self.assertEqual(by_id["node/101"]["match_method"], "inside")
        self.assertEqual(by_id["node/102"]["match_method"], "nearest")
        self.assertEqual(by_id["node/106"]["match_method"], "unmatched")

        broad_res = geom_to_meters(box(122.9515, 10.6715, 122.9530, 10.6730))
        small_retail = geom_to_meters(box(122.9519, 10.6719, 122.9523, 10.6723))
        landuse_items = [
            (broad_res.area, "residential", broad_res),
            (small_retail.area, "retail", small_retail),
        ]

        classify_buildings(
            building_ids=self.b_ids,
            building_geoms_m=self.b_geoms_m,
            building_props=self.b_props,
            building_matches=building_matches,
            landuse_items=landuse_items,
        )

        self.assertEqual(self.b_props["b-shophouse"]["bclass"], "mixed_use")
        self.assertEqual(self.b_props["b-shophouse"]["orig_bclass"], "house")
        self.assertEqual(self.b_props["b-shophouse"]["class_source"], "osm_poi_inside")
        self.assertGreater(self.b_props["b-shophouse"]["effective_height"], 9.5)

        self.assertEqual(self.b_props["b-nearest"]["bclass"], "retail")
        self.assertEqual(self.b_props["b-nearest"]["class_source"], "osm_poi_nearest")
        self.assertEqual(self.b_props["b-nearest"]["effective_height"], 6.4)

        self.assertEqual(self.b_props["b-landuse"]["bclass"], "retail")
        self.assertEqual(self.b_props["b-landuse"]["class_source"], "osm_landuse")

        self.assertEqual(self.b_props["b-explicit"]["bclass"], "school")
        self.assertEqual(self.b_props["b-explicit"]["class_source"], "overture")

        self.assertEqual(self.b_props["b-multi"]["bclass"], "mixed_use")
        self.assertEqual(self.b_props["b-multi"]["poi_count"], 2)

        building_pois, labels_fc = build_building_pois_and_labels(
            building_ids=self.b_ids,
            building_geoms_deg=self.b_geoms_deg,
            building_props=self.b_props,
            building_matches=building_matches,
        )
        self.assertEqual(set(building_pois.keys()), {"b-shophouse", "b-nearest", "b-explicit", "b-multi"})
        self.assertEqual(len(building_pois["b-multi"]["pois"]), 2)
        self.assertEqual(building_pois["b-multi"]["label"], "7-Eleven (+1)")
        self.assertEqual(len(labels_fc["features"]), 4)

        # Idempotent re-run preserves orig_bclass and exact classes
        classify_buildings(
            building_ids=self.b_ids,
            building_geoms_m=self.b_geoms_m,
            building_props=self.b_props,
            building_matches=building_matches,
            landuse_items=landuse_items,
        )
        self.assertEqual(self.b_props["b-shophouse"]["orig_bclass"], "house")
        self.assertEqual(self.b_props["b-shophouse"]["bclass"], "mixed_use")
        self.assertEqual(self.b_props["b-explicit"]["bclass"], "school")

    def test_compound_polygons_name_keywords_gating_and_morphology(self) -> None:
        raw_compounds = [
            {
                "type": "way",
                "id": 9001,
                "tags": {"amenity": "university", "name": "Test University"},
                "geometry": [
                    {"lat": 10.6700, "lon": 122.9500},
                    {"lat": 10.6700, "lon": 122.9510},
                    {"lat": 10.6710, "lon": 122.9510},
                    {"lat": 10.6710, "lon": 122.9500},
                    {"lat": 10.6700, "lon": 122.9500},
                ],
            },
            {
                "type": "relation",
                "id": 9002,
                "tags": {"landuse": "industrial"},
                "members": [
                    {
                        "type": "way",
                        "role": "outer",
                        "geometry": [
                            {"lat": 10.6800, "lon": 122.9600},
                            {"lat": 10.6800, "lon": 122.9610},
                        ],
                    },
                    {
                        "type": "way",
                        "role": "outer",
                        "geometry": [
                            {"lat": 10.6800, "lon": 122.9610},
                            {"lat": 10.6810, "lon": 122.9610},
                            {"lat": 10.6810, "lon": 122.9600},
                            {"lat": 10.6800, "lon": 122.9600},
                        ],
                    },
                ],
            },
        ]
        comp_items, lu_extra = parse_osm_compounds(raw_compounds)
        self.assertEqual(len(comp_items), 1)
        self.assertEqual(comp_items[0][1], "university")
        self.assertEqual(len(lu_extra), 1)
        self.assertEqual(lu_extra[0][1], "industrial")

        # Keyword rules
        self.assertEqual(classify_building_name("Bacolod Barangay 17 Hall"), ("government", "verified"))
        self.assertEqual(classify_building_name("St. Jude Chapel"), ("religious", "verified"))
        self.assertEqual(classify_building_name("Lopues Hardware"), ("retail", "medium"))
        self.assertEqual(classify_building_name("Negros Ice Plant & Bodega"), ("industrial", "medium"))

        # Shophouse rule on small house inside residential landuse + weak third-party nearest gate
        small_shophouse = [{"mapped_bclass": "commercial", "category": "food", "poi_value": "cafe",
                            "building_applicable": True, "match_method": "nearest",
                            "match_distance_m": 4.0, "priority": 85, "source": "osm"}]
        self.assertEqual(
            resolve_poi_building_class(small_shophouse, "unknown", area_m2=100.0, in_residential_landuse=True),
            "mixed_use",
        )
        weak_ovt = [{"mapped_bclass": "commercial", "category": "commercial", "building_applicable": True,
                     "match_method": "nearest", "match_distance_m": 18.0, "confidence": 0.68,
                     "priority": 75, "source": "overture"}]
        self.assertIsNone(resolve_poi_building_class(weak_ovt, "unknown"))

        # Morphology inference: campus, named, arterial commercial, industrial warehouse, res cluster & shed
        b_ids = [
            "campus-wing",
            "named-hall",
            "art-comm-1",
            "art-comm-2",
            "art-infer",
            "wh-infer",
            "res-anchor",
            "res-infer",
            "tiny-shed",
        ]
        b_geoms_deg = [
            box(122.9503, 10.6703, 122.9506, 10.6705),  # inside university compound
            box(122.9515, 10.6703, 122.9517, 10.6705),  # named Barangay Hall
            box(122.9550, 10.67205, 122.9552, 10.6722), # commercial 1 along arterial
            box(122.9553, 10.67205, 122.9555, 10.6722), # commercial 2 along arterial
            box(122.9556, 10.67205, 122.9559, 10.6723), # unknown >260m2 along arterial -> morph_arterial commercial
            box(122.9700, 10.6900, 122.9704, 10.6903),  # ~43m x 33m (~1400 m2 rect) -> morph_industrial
            box(122.9400, 10.6600, 122.9401, 10.6601),  # residential anchor
            box(122.9402, 10.6600, 122.9403, 10.6601),  # neighbor house -> morph_residential
            box(122.9900, 10.6950, 122.99002, 10.69502), # tiny isolated ~5 m2 shed -> stays unknown
        ]
        b_geoms_m = [geom_to_meters(g) for g in b_geoms_deg]
        b_props = {
            "campus-wing": {"id": "campus-wing", "bclass": "unknown", "height_source": "estimated", "area_m2": 300.0},
            "named-hall": {"id": "named-hall", "bclass": "unknown", "orig_name": "Barangay Hall", "height_source": "estimated", "area_m2": 180.0},
            "art-comm-1": {"id": "art-comm-1", "bclass": "commercial", "orig_bclass": "commercial", "height_source": "estimated", "area_m2": 200.0},
            "art-comm-2": {"id": "art-comm-2", "bclass": "commercial", "orig_bclass": "commercial", "height_source": "estimated", "area_m2": 200.0},
            "art-infer": {"id": "art-infer", "bclass": "unknown", "height_source": "estimated", "area_m2": 450.0},
            "wh-infer": {"id": "wh-infer", "bclass": "unknown", "height_source": "estimated", "area_m2": 1400.0},
            "res-anchor": {"id": "res-anchor", "bclass": "house", "orig_bclass": "house", "height_source": "estimated", "area_m2": 110.0},
            "res-infer": {"id": "res-infer", "bclass": "unknown", "height_source": "estimated", "area_m2": 110.0},
            "tiny-shed": {"id": "tiny-shed", "bclass": "unknown", "height_source": "estimated", "area_m2": 5.0},
        }
        arterial = [geom_to_meters(LineString([(122.9545, 10.6720), (122.9565, 10.6720)]))]

        summary = classify_buildings(
            building_ids=b_ids,
            building_geoms_m=b_geoms_m,
            building_props=b_props,
            building_matches={},
            landuse_items=[],
            compound_items=comp_items,
            arterial_roads_m=arterial,
        )

        self.assertEqual(b_props["campus-wing"]["bclass"], "university")
        self.assertEqual(b_props["campus-wing"]["class_source"], "osm_compound")
        self.assertEqual(b_props["campus-wing"]["class_confidence"], "verified")

        self.assertEqual(b_props["named-hall"]["bclass"], "government")
        self.assertEqual(b_props["named-hall"]["class_source"], "name_keyword")
        self.assertEqual(b_props["named-hall"]["class_confidence"], "verified")

        self.assertEqual(b_props["art-infer"]["bclass"], "commercial")
        self.assertEqual(b_props["art-infer"]["class_source"], "morph_arterial")
        self.assertEqual(b_props["art-infer"]["class_confidence"], "inferred")

        self.assertEqual(b_props["wh-infer"]["bclass"], "industrial")
        self.assertEqual(b_props["wh-infer"]["class_source"], "morph_industrial")

        self.assertEqual(b_props["res-infer"]["bclass"], "residential")
        self.assertEqual(b_props["res-infer"]["class_source"], "morph_residential")
        self.assertEqual(b_props["res-infer"]["class_confidence"], "inferred")

        self.assertEqual(b_props["tiny-shed"]["bclass"], "unknown")
        self.assertEqual(b_props["tiny-shed"]["class_confidence"], "unknown")
        self.assertEqual(summary["class_confidence"]["unknown"], 1)

    def test_trust_gating_for_classification_labels_and_wrong_barangay_drop(self) -> None:
        raw = [
            {"osm_id": "node/1", "source": "osm", "name": "OSM Wrong Brgy", "barangay_vote": -2},
            {"osm_id": "ovt/bad", "source": "overture", "name": "Daily Grind Cafe", "barangay_vote": -2},
            {"osm_id": "ovt/ok", "source": "overture", "name": "Good Place", "barangay_vote": 1},
        ]
        kept, dropped = filter_wrong_barangay_pois(raw)
        self.assertEqual(dropped, 1)
        self.assertEqual([p["osm_id"] for p in kept], ["node/1", "ovt/ok"])

        b_ids = ["b-unverified", "b-unrated", "b-verified"]
        b_geoms_deg = [
            box(122.9500, 10.6700, 122.9502, 10.6702),
            box(122.9520, 10.6720, 122.9522, 10.6722),
            box(122.9540, 10.6740, 122.9542, 10.6742),
        ]
        b_geoms_m = [geom_to_meters(g) for g in b_geoms_deg]
        b_props = {
            bid: {"id": bid, "bclass": "unknown", "height_source": "estimated", "area_m2": 200.0}
            for bid in b_ids
        }
        pois = [
            {
                "osm_id": "ovt/unv",
                "source": "overture",
                "confidence": 0.90,
                "priority": 80,
                "name": "Suspect Pin",
                "lon": 122.9501,
                "lat": 10.6701,
                "poi_key": "overture",
                "poi_value": "cafe",
                "category": "food",
                "mapped_bclass": "commercial",
                "building_applicable": True,
                "trust": "unverified",
                "vote_score": -1,
                "votes": ["street:-1"],
            },
            {
                "osm_id": "fsq-ovt/unr",
                "source": "foursquare",
                "confidence": 0.77,
                "priority": 75,
                "name": "Unrated Cafe",
                "lon": 122.9521,
                "lat": 10.6721,
                "poi_key": "overture",
                "poi_value": "coffee_shop",
                "category": "food",
                "mapped_bclass": "commercial",
                "building_applicable": True,
                "trust": "unrated",
                "vote_score": 0,
                "votes": [],
                "updated": "2025-04-01",
            },
            {
                "osm_id": "ovt/ver",
                "source": "overture",
                "confidence": 0.90,
                "priority": 80,
                "name": "Verified Diner",
                "lon": 122.9541,
                "lat": 10.6741,
                "poi_key": "overture",
                "poi_value": "restaurant",
                "category": "food",
                "mapped_bclass": "commercial",
                "building_applicable": True,
                "trust": "verified",
                "vote_score": 1,
                "votes": ["street:+1"],
                "updated": "2026-06-15",
            },
        ]
        _, matches = match_pois_to_buildings(pois, b_ids, b_geoms_m, max_distance_m=30.0)
        classify_buildings(b_ids, b_geoms_m, b_props, matches)

        # Unverified pin must NOT classify or name its building
        self.assertEqual(b_props["b-unverified"]["bclass"], "unknown")
        self.assertIsNone(b_props["b-unverified"].get("name"))

        # Unrated inside pin classifies with 'medium' confidence; verified inside gets 'verified'
        self.assertEqual(b_props["b-unrated"]["bclass"], "commercial")
        self.assertEqual(b_props["b-unrated"]["class_confidence"], "medium")
        self.assertEqual(b_props["b-verified"]["bclass"], "commercial")
        self.assertEqual(b_props["b-verified"]["class_confidence"], "verified")

        building_pois, labels_fc = build_building_pois_and_labels(
            b_ids, b_geoms_deg, b_props, matches
        )
        # Unverified POI stays inspectable in building_pois.json (with votes) but has NO floating label
        self.assertEqual(building_pois["b-unverified"]["pois"][0]["trust"], "unverified")
        self.assertNotIn("label", building_pois["b-unverified"])
        self.assertEqual(building_pois["b-unrated"]["pois"][0]["updated"], "2025-04-01")
        label_ids = {feat["properties"]["id"] for feat in labels_fc["features"]}
        self.assertEqual(label_ids, {"b-unrated", "b-verified"})


if __name__ == "__main__":
    unittest.main()
