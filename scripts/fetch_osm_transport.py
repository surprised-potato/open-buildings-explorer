#!/usr/bin/env python3
"""Transport-related OSM data for one place: signals, crossings, bus stops, jeepney/bus routes, and a
tag-coverage audit of the road network. Read from the downloaded OSM snapshot (extract_osm_region.py);
nothing is fetched live.

Output: public/data/<place>/transport_osm.json
  signals  [[lon, lat], ...]            highway=traffic_signals nodes
  crossings count                       highway=crossing nodes
  stops    [{name, lon, lat}]           highway=bus_stop and public_transport=platform
  routes   [{id, ref, name, from, to, operator, mode, geometry}]  route=bus|share_taxi|minibus relations
  coverage {highway class: {ways, lanes, maxspeed, oneway}}       how often each tag is present
Also writes transit_routes.geojson (city routes + stops) for the map layer.

Licence: ODbL (OpenStreetMap contributors). Run with `uv run python -I scripts/fetch_osm_transport.py`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT = PLACE.out_dir / "transport_osm.json"
TRANSIT_OUT = PLACE.out_dir / "transit_routes.geojson"
ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"]


def coverage(ways: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Per highway class: ways, and how many carry lanes / maxspeed / oneway tags."""
    out = {c: {"ways": 0, "lanes": 0, "maxspeed": 0, "oneway": 0} for c in ROAD_CLASSES}
    for w in ways:
        tags = w.get("tags") or {}
        hw = tags.get("highway", "")
        if hw not in out:
            continue
        o = out[hw]
        o["ways"] += 1
        o["lanes"] += int("lanes" in tags)
        o["maxspeed"] += int("maxspeed" in tags)
        o["oneway"] += int(tags.get("oneway") in ("yes", "true", "1", "-1"))
    return out


def route_record(rel: dict[str, Any]) -> dict[str, Any] | None:
    tags = rel.get("tags") or {}
    lines: list[list[list[float]]] = []
    for m in rel.get("members", []):
        if m.get("type") == "way" and m.get("geometry") and m.get("role", "") in ("", "forward", "backward"):
            lines.append([[round(p["lon"], 6), round(p["lat"], 6)] for p in m["geometry"]])
    if not lines:
        return None
    return {
        "id": rel["id"],
        "ref": tags.get("ref", ""),
        "name": tags.get("name", ""),
        "from": tags.get("from", ""),
        "to": tags.get("to", ""),
        "operator": tags.get("operator", ""),
        "mode": tags.get("route", ""),
        "geometry": lines,
    }


def build(raw: dict[str, Any]) -> dict[str, Any]:
    signals = [[round(e["lon"], 6), round(e["lat"], 6)] for e in raw["signals"]["elements"] if e["type"] == "node"]
    stops = [
        {"name": (e.get("tags") or {}).get("name", ""), "lon": round(e["lon"], 6), "lat": round(e["lat"], 6)}
        for e in raw["stops"]["elements"]
        if e["type"] == "node"
    ]
    routes = [r for r in (route_record(e) for e in raw["routes"]["elements"] if e["type"] == "relation") if r]
    return {
        "source": raw.get("source", "OpenStreetMap contributors (ODbL)"),
        "fetched_at": raw.get("fetched_at"),
        "signals": signals,
        "crossings": len([e for e in raw["crossings"]["elements"] if e["type"] == "node"]),
        "stops": stops,
        "routes": routes,
        "coverage": coverage(raw["roads"]["elements"]),
    }


def is_city_route(route: dict[str, Any]) -> bool:
    """City routes only: intercity coaches (Ceres Tours etc.) run far outside Bacolod."""
    text = f"{route.get('name', '')} {route.get('ref', '')} {route.get('operator', '')}".lower()
    return "ceres" not in text and len(route["geometry"]) < 200


def transit_geojson(out: dict[str, Any]) -> dict[str, Any]:
    """City bus / jeepney routes as MultiLineStrings plus stops as points, for the map layer."""
    feats: list[dict[str, Any]] = []
    for r in out["routes"]:
        if not is_city_route(r):
            continue
        feats.append(
            {
                "type": "Feature",
                "properties": {k: r[k] for k in ("id", "ref", "name", "from", "to", "operator", "mode")} | {"kind": "route"},
                "geometry": {"type": "MultiLineString", "coordinates": r["geometry"]},
            }
        )
    for s in out["stops"]:
        feats.append(
            {
                "type": "Feature",
                "properties": {"name": s["name"], "kind": "stop"},
                "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
            }
        )
    return {
        "type": "FeatureCollection",
        "name": f"{PLACE.file_prefix}_transit",
        "meta": {"source": out["source"], "fetched_at": out.get("fetched_at"), "note": "OSM route relations; not the official LPTRP"},
        "features": feats,
    }


def fetch_all() -> dict[str, Any]:
    """The five result sets the Overpass queries returned, cut from the downloaded snapshot for this place."""
    from osm_snapshot import meta, source_label, transport

    raw: dict[str, Any] = transport(PLACE.bbox)
    raw["fetched_at"] = meta().get("osm_timestamp")
    raw["source"] = f"OpenStreetMap contributors (ODbL), {source_label()}"
    return raw


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--from-cache", type=Path, default=None,
                    help="rebuild from a saved raw file (e.g. the old data/osm/bacolod/transport_raw.json) instead of the snapshot")
    args = ap.parse_args()
    raw = json.loads(args.from_cache.read_text(encoding="utf-8")) if args.from_cache else fetch_all()
    out = build(raw)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    TRANSIT_OUT.write_text(json.dumps(transit_geojson(out), separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(
        f"{len(out['signals'])} signals, {out['crossings']} crossings, {len(out['stops'])} stops, "
        f"{len(out['routes'])} routes; wrote {OUT.stat().st_size / 1e3:.0f} kB"
    )


if __name__ == "__main__":
    sys.exit(main())
