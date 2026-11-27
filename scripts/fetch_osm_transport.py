#!/usr/bin/env python3
"""Pull transport-related OSM data for Bacolod: signals, crossings, bus stops, jeepney/bus routes, and a
tag-coverage audit of the road network.

Output: public/data/bacolod/transport_osm.json (and a raw cache in data/osm/, not served)
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
import time
from pathlib import Path
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = REPO_ROOT / "data" / "osm"
OUT = REPO_ROOT / "public" / "data" / "bacolod" / "transport_osm.json"
TRANSIT_OUT = REPO_ROOT / "public" / "data" / "bacolod" / "transit_routes.geojson"
BBOX = (10.58, 122.89, 10.74, 123.14)  # south, west, north, east (Overpass order)
ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential"]


def overpass(query: str, retries: int = 3) -> dict[str, Any]:
    """POST a query to the first Overpass endpoint that answers with JSON."""
    last: Exception | None = None
    for attempt in range(retries):
        for url in ENDPOINTS:
            try:
                r = requests.post(url, data={"data": query}, timeout=180, headers={"User-Agent": "bacolod-twin-pipeline/0.1"})
                if r.ok and r.text.lstrip().startswith("{"):
                    return r.json()
                last = RuntimeError(f"{url}: HTTP {r.status_code}")
            except requests.RequestException as e:
                last = e
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"All Overpass endpoints failed: {last}")


def bbox_str() -> str:
    return ",".join(str(v) for v in BBOX)


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
        "source": "OpenStreetMap contributors (ODbL), via Overpass",
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
        "name": "bacolod_transit",
        "meta": {"source": out["source"], "fetched_at": out.get("fetched_at"), "note": "OSM route relations; not the official LPTRP"},
        "features": feats,
    }


def fetch_all() -> dict[str, Any]:
    b = bbox_str()
    queries = {
        "signals": f"[out:json][timeout:120];node[highway=traffic_signals]({b});out;",
        "crossings": f"[out:json][timeout:120];node[highway=crossing]({b});out ids;",
        "stops": f"[out:json][timeout:120];(node[highway=bus_stop]({b});node[public_transport=platform]({b}););out;",
        "routes": f'[out:json][timeout:180];relation[route~"^(bus|share_taxi|minibus)$"]({b});out geom;',
        "roads": f'[out:json][timeout:180];way[highway~"^({"|".join(ROAD_CLASSES)})$"]({b});out tags;',
    }
    raw: dict[str, Any] = {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for k, q in queries.items():
        print(f"fetching {k}...")
        raw[k] = overpass(q)
        time.sleep(2)
    return raw


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from-cache", action="store_true", help="rebuild from data/osm/transport_raw.json without fetching")
    args = ap.parse_args()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cache = RAW_DIR / "transport_raw.json"
    if args.from_cache and cache.exists():
        raw = json.loads(cache.read_text(encoding="utf-8"))
    else:
        raw = fetch_all()
        cache.write_text(json.dumps(raw), encoding="utf-8")
    out = build(raw)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    TRANSIT_OUT.write_text(json.dumps(transit_geojson(out), separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(
        f"{len(out['signals'])} signals, {out['crossings']} crossings, {len(out['stops'])} stops, "
        f"{len(out['routes'])} routes; wrote {OUT.stat().st_size / 1e3:.0f} kB"
    )


if __name__ == "__main__":
    sys.exit(main())
