"""Cut everything the pipeline needs from OpenStreetMap out of one downloaded Geofabrik file.

The pipeline never queries OSM live (no Overpass API). It reads a dated snapshot:
  Input : data/osm/geofabrik/philippines-*.osm.pbf (newest file; Geofabrik, ODbL)
  Output: data/osm/<region>/ (untrusted-input folder, not served), all in Overpass JSON shapes so the
          scripts that used to call Overpass parse them unchanged:

  roads.json          drivable ways with node refs + geometry: trafficsim_map's importer filter
                      (osm_import.HIGHWAY_REGEX, access not no/private)          -> build_road_network.py
  econ_pois.json      activity features trafficsim's economy model counts, `out center` shape
  econ_buildings.json buildings whose building=* trafficsim maps to an activity, with geometry
  osm_pois.json       shop/amenity/office/tourism/healthcare/craft/leisure/industrial nodes and ways,
                      `out tags center` shape                                    -> enrich_osm_buildings.py
  osm_compounds.json  campus, compound and land-use outlines (ways + multipolygon relations), `out tags geom`
  transport.json      traffic signals, crossings, bus stops / platforms, bus / jeepney route relations with
                      member geometry, road tags for the lane / speed audit      -> fetch_osm_transport.py
  boundaries.geojson  administrative areas, admin_level 6-7 (cities, municipalities) and 10 (barangays)
                                                                                 -> fetch_bacolod.py fallback
  meta.json           source file, OSM timestamp, counts

Objects are kept when a coordinate falls inside the region bbox (regions/<region>.json "bbox");
scripts/osm_snapshot.py then picks one place's share by its own bbox, the way an Overpass bbox query did.
Run: uv run python -I scripts/extract_osm_region.py   (the PBF is untrusted input)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, load_region  # noqa: E402

VENDOR = REPO_ROOT / "vendor" / "trafficsim"
sys.path.insert(0, str(VENDOR))
import osm_import  # noqa: E402  (vendored trafficsim)
from server import economy  # noqa: E402

GEOFABRIK_DIR = REPO_ROOT / "data" / "osm" / "geofabrik"
HIGHWAY_RE = re.compile(osm_import.HIGHWAY_REGEX)
ACCESS_BLOCKED = re.compile(r"^(no|private)$")
ADMIN_LEVELS = {"6", "7", "10"}

# enrich_osm_buildings.fetch_osm_pois: nw["shop"|"amenity"|...]; out tags center
OSM_POI_KEYS = ("shop", "amenity", "office", "tourism", "healthcare", "craft", "leisure", "industrial")
# enrich_osm_buildings.fetch_osm_compounds: wr[...]; out tags geom
COMPOUND_AMENITY = re.compile(r"^(school|university|college|kindergarten|hospital|clinic|place_of_worship|marketplace|"
                              r"townhall|courthouse|police|fire_station|bus_station|ferry_terminal)$")
COMPOUND_SHOP = re.compile(r"^(mall|supermarket|department_store)$")
COMPOUND_LANDUSE = re.compile(r"^(commercial|retail|industrial|residential|institutional|education|religious)$")
# fetch_osm_transport.fetch_all
TRANSIT_ROUTE = re.compile(r"^(bus|share_taxi|minibus)$")
AUDIT_ROAD_CLASSES = re.compile(r"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$")

FILTER_KEYS = ("highway", "building", "boundary", "landuse", "man_made", "route", "public_transport", *OSM_POI_KEYS)


def newest_pbf(folder: Path = GEOFABRIK_DIR) -> Path:
    files = sorted(folder.glob("philippines-*.osm.pbf"))
    if not files:
        raise SystemExit(f"No philippines-*.osm.pbf in {folder}. Download it from download.geofabrik.de first.")
    return files[-1]


def in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    w, s, e, n = bbox
    return s <= lat <= n and w <= lon <= e


def is_road(tags: dict[str, str]) -> bool:
    return bool(HIGHWAY_RE.match(tags.get("highway", ""))) and not ACCESS_BLOCKED.match(tags.get("access", ""))


def is_econ_poi(tags: dict[str, str]) -> bool:
    return bool(economy.classify(tags))


def is_econ_building(tags: dict[str, str]) -> bool:
    return tags.get("building") in economy.BUILDING_CAT


def is_osm_poi(tags: dict[str, str]) -> bool:
    return any(k in tags for k in OSM_POI_KEYS)


def is_compound(tags: dict[str, str]) -> bool:
    return bool(COMPOUND_AMENITY.match(tags.get("amenity", "")) or COMPOUND_SHOP.match(tags.get("shop", ""))
                or tags.get("tourism") == "resort" or COMPOUND_LANDUSE.match(tags.get("landuse", "")))


def is_stop(tags: dict[str, str]) -> bool:
    return tags.get("highway") == "bus_stop" or tags.get("public_transport") == "platform"


def bbox_center(geom: list[dict[str, float]]) -> dict[str, float]:
    """Overpass `out center` for a way: centre of its bounding box."""
    la = [p["lat"] for p in geom]
    lo = [p["lon"] for p in geom]
    return {"lat": round((min(la) + max(la)) / 2, 7), "lon": round((min(lo) + max(lo)) / 2, 7)}


def way_geometry(way: Any) -> tuple[list[int], list[dict[str, float]]] | None:
    try:
        nodes = [n.ref for n in way.nodes]
        geom = [{"lat": round(n.lat, 7), "lon": round(n.lon, 7)} for n in way.nodes]
    except Exception:  # missing node location (way crosses the extract edge)
        return None
    return (nodes, geom) if len(geom) >= 2 else None


def extract(pbf: Path, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    import osmium
    from shapely.geometry import mapping, shape

    out: dict[str, list] = {k: [] for k in ("roads", "econ_pois", "econ_buildings", "osm_pois", "compounds",
                                            "signals", "crossings", "stops", "routes", "audit_roads", "boundaries")}
    highway_geom: dict[int, list[dict[str, float]]] = {}  # route members (ways come before relations in a PBF)
    seen_econ: set[tuple[str, int]] = set()
    t0 = time.time()
    fp = (osmium.FileProcessor(str(pbf)).with_locations().with_areas()
          .with_filter(osmium.filter.KeyFilter(*FILTER_KEYS)))
    geo = osmium.geom.GeoJSONFactory()
    for obj in fp:
        tags = dict(obj.tags)
        if obj.is_node():
            lat, lon = obj.location.lat, obj.location.lon
            if not in_bbox(lat, lon, bbox):
                continue
            node = {"type": "node", "id": obj.id, "lat": round(lat, 7), "lon": round(lon, 7), "tags": tags}
            if is_econ_poi(tags):
                out["econ_pois"].append(node)
            if is_osm_poi(tags):
                out["osm_pois"].append(node)
            hw = tags.get("highway")
            if hw == "traffic_signals":
                out["signals"].append(node)
            elif hw == "crossing":
                out["crossings"].append({"type": "node", "id": obj.id, "lat": node["lat"], "lon": node["lon"]})
            if is_stop(tags):
                out["stops"].append(node)
        elif obj.is_way():
            wg = way_geometry(obj)
            if wg is None:
                continue
            nodes, geom = wg
            if not any(in_bbox(p["lat"], p["lon"], bbox) for p in geom):
                continue
            if "highway" in tags:
                highway_geom[obj.id] = geom
                if AUDIT_ROAD_CLASSES.match(tags["highway"]):
                    out["audit_roads"].append({"type": "way", "id": obj.id, "tags": tags, "geometry": geom})
            if is_road(tags):
                out["roads"].append({"type": "way", "id": obj.id, "nodes": nodes, "geometry": geom, "tags": tags})
            if is_econ_building(tags):
                out["econ_buildings"].append({"type": "way", "id": obj.id, "geometry": geom, "tags": tags})
            center = bbox_center(geom)
            if is_econ_poi(tags):
                seen_econ.add(("way", obj.id))
                out["econ_pois"].append({"type": "way", "id": obj.id, "center": center, "tags": tags})
            if is_osm_poi(tags):
                out["osm_pois"].append({"type": "way", "id": obj.id, "center": center, "tags": tags})
            if is_compound(tags):
                out["compounds"].append({"type": "way", "id": obj.id, "geometry": geom, "tags": tags})
        elif obj.is_relation():
            if TRANSIT_ROUTE.match(tags.get("route", "")):
                members = []
                touches = False
                for m in obj.members:
                    rec: dict[str, Any] = {"type": {"n": "node", "w": "way", "r": "relation"}[m.type], "ref": m.ref, "role": m.role}
                    if m.type == "w" and m.ref in highway_geom:
                        rec["geometry"] = highway_geom[m.ref]
                        touches = touches or any(in_bbox(p["lat"], p["lon"], bbox) for p in rec["geometry"])
                    members.append(rec)
                if touches:
                    out["routes"].append({"type": "relation", "id": obj.id, "members": members, "tags": tags})
        elif obj.is_area():
            if obj.from_way():
                continue  # closed ways were handled above
            try:
                g = shape(json.loads(geo.create_multipolygon(obj)))
            except Exception:
                continue
            c = g.representative_point()
            if not in_bbox(c.y, c.x, bbox):
                continue
            rel_id = obj.orig_id()
            if tags.get("boundary") == "administrative" and tags.get("admin_level") in ADMIN_LEVELS:
                out["boundaries"].append({"type": "Feature", "geometry": mapping(g),
                                          "properties": {"osm_relation": rel_id, "name": tags.get("name", ""),
                                                         "admin_level": int(tags["admin_level"]),
                                                         "ref_psgc": tags.get("ref:psgc") or tags.get("psgc") or tags.get("ref")}})
                continue
            if is_econ_poi(tags) and ("relation", rel_id) not in seen_econ:
                seen_econ.add(("relation", rel_id))
                out["econ_pois"].append({"type": "relation", "id": rel_id, "center": {"lat": c.y, "lon": c.x}, "tags": tags})
            if is_compound(tags):
                members = []
                for outer in obj.outer_rings():
                    members.append({"type": "way", "role": "outer",
                                    "geometry": [{"lat": round(n.lat, 7), "lon": round(n.lon, 7)} for n in outer]})
                    for inner in obj.inner_rings(outer):
                        members.append({"type": "way", "role": "inner",
                                        "geometry": [{"lat": round(n.lat, 7), "lon": round(n.lon, 7)} for n in inner]})
                out["compounds"].append({"type": "relation", "id": rel_id, "members": members, "tags": tags})
    out["seconds"] = round(time.time() - t0, 1)  # type: ignore[assignment]
    return out


def write_outputs(res: dict[str, Any], out_dir: Path, pbf: Path, bbox) -> dict[str, Any]:
    import osmium

    out_dir.mkdir(parents=True, exist_ok=True)

    def dump(name: str, obj: Any) -> None:
        (out_dir / name).write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    header = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING).header()
    stamp = header.get("osmosis_replication_timestamp", "")
    dump("roads.json", {"elements": res["roads"]})
    dump("econ_pois.json", {"elements": res["econ_pois"]})
    dump("econ_buildings.json", {"elements": res["econ_buildings"]})
    dump("osm_pois.json", {"elements": res["osm_pois"]})
    dump("osm_compounds.json", {"elements": res["compounds"]})
    dump("transport.json", {"osm_timestamp": stamp, "signals": res["signals"], "crossings": res["crossings"],
                            "stops": res["stops"], "routes": res["routes"], "roads": res["audit_roads"]})
    dump("boundaries.geojson", {"type": "FeatureCollection", "features": res["boundaries"]})
    meta = {
        "source": f"Geofabrik extract {pbf.name} (OpenStreetMap contributors, ODbL)",
        "pbf": pbf.name,
        "osm_timestamp": stamp,
        "bbox": list(bbox),
        "counts": {k: len(v) for k, v in res.items() if isinstance(v, list)},
        "seconds": res["seconds"],
    }
    dump("meta.json", meta)
    return meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="negros-occidental")
    ap.add_argument("--pbf", type=Path, default=None)
    ap.add_argument("--place", default=None, help="ignored; accepted so the pipeline can pass it")
    args = ap.parse_args()
    reg = load_region(args.region)
    bbox = tuple(reg["bbox"])
    pbf = args.pbf or newest_pbf()
    print(f"Reading {pbf.name} for {args.region} {bbox} ...")
    res = extract(pbf, bbox)
    meta = write_outputs(res, REPO_ROOT / "data" / "osm" / args.region, pbf, bbox)
    print(f"{meta['counts']} in {meta['seconds']}s (OSM as of {meta['osm_timestamp'] or 'unknown'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
