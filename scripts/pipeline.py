"""Run the data pipeline for one or more places (LGUs) from regions/negros-occidental.json.

  uv run scripts/pipeline.py --place bacolod              # run what is out of date
  uv run scripts/pipeline.py --place bacolod --offline    # never touch the network
  uv run scripts/pipeline.py --all --refresh              # re-fetch sources for every live/pilot place
  uv run scripts/pipeline.py --place bacolod --only analytics,zonal --force
  uv run scripts/pipeline.py --list

How "out of date" works
  Each stage has a fingerprint: a hash of its code, the place's registry entry, its raw input files
  (BIR workbook, NOAH zips, PSA census, ...) and the fingerprints of the stages it depends on. A stage
  reruns when its fingerprint changes or an output is missing, and that change ripples downstream.
  Output files are not hashed: several stages enrich boundaries.geojson and barangay_analytics.json
  in place, so content hashes would never settle.

  Network stages (Overture on S3, Copernicus DEM) run only when their outputs are missing, or with
  --refresh / --force. A code or settings change alone does not re-fetch. With --offline they never
  run; existing outputs are adopted as they are.

Stamps live in build/<place>/stamps.json and the QA report in build/<place>/qa.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, Place, PlaceNotConfigured, all_places, get_place  # noqa: E402

SCRIPTS = REPO_ROOT / "scripts"
BUILD = REPO_ROOT / "build"
BIG_FILE = 50 * 1024 * 1024  # larger raw inputs are fingerprinted by size + mtime, not content
RUNNABLE_STATUSES = ("live", "pilot")


@dataclass(frozen=True)
class Stage:
    name: str
    script: str
    deps: tuple[str, ...]
    outputs: Callable[[Place], list[Path]]
    raw_inputs: Callable[[Place], list[Path]] = lambda p: []
    helpers: tuple[str, ...] = ()
    network: bool = False
    isolated: bool = True  # run with python -I (untrusted inputs); some scripts need sibling imports
    args: Callable[[Place], list[str]] = lambda p: []
    description: str = ""
    # A network stage that can rebuild from a local cache counts as local when the cache exists.
    local_cache: Callable[[Place], bool] = lambda p: False
    # Stages that do not apply to a place are skipped (e.g. the network build for Bacolod, which keeps
    # its calibrated trafficsim state).
    applies: Callable[[Place], bool] = lambda p: True

    def is_network(self, place: Place) -> bool:
        return self.network and not self.local_cache(place)


def _o(*names: str) -> Callable[[Place], list[Path]]:
    return lambda p: [p.out_dir / n for n in names]


def _noah(p: Place) -> list[Path]:
    prov = p.setting("noah_province", "NegrosOccidental")
    keys = ["flood_5yr", "flood_25yr", "flood_100yr", "surge_ssa1", "surge_ssa2", "surge_ssa3", "surge_ssa4"]
    return [REPO_ROOT / "data" / "noah" / f"{k}_{prov}.zip" for k in keys]


def _bir(p: Place) -> list[Path]:
    xls = (p.setting("bir") or {}).get("xls")
    return [REPO_ROOT / xls] if xls else []


def _psa(p: Place) -> list[Path]:
    return [REPO_ROOT / "data" / "psa" / "2020_popn_single_age_admin4.xlsx"]


REGION_OSM = REPO_ROOT / "data" / "osm" / "negros-occidental"


def _state_dir(p: Place) -> Path:
    """Calibrated external trafficsim state (Bacolod) or the one build_road_network.py writes."""
    return p.trafficsim_state or BUILD / p.slug / "trafficsim_state"


def _mobility_raw(p: Place) -> list[Path]:
    files = [REPO_ROOT / "data" / "popgrid" / "phl_pop_2020_CN_100m_R2025A_v1.tif"]
    if p.trafficsim_state:
        files += sorted(_state_dir(p).glob("*"))
    return files


def _builds_network(p: Place) -> bool:
    return p.trafficsim_state is None


def _network_raw(p: Place) -> list[Path]:
    ref = get_place("bacolod").trafficsim_state or BUILD / "bacolod" / "trafficsim_state"
    return [REGION_OSM / "meta.json", ref / "state.json"]


def _landcover(p: Place) -> list[Path]:
    return [REPO_ROOT / p.setting("landcover_tif", "data/landcover/worldcover_2021_negros-occidental.tif")]


STAGES: list[Stage] = [
    Stage("fetch", "fetch_bacolod.py", (), lambda p: [p.pmtiles("buildings"), p.pmtiles("roads"), p.pmtiles("base"), p.out_dir / "boundaries.geojson", p.out_dir / "manifest.json"],
          helpers=("enrich_osm_buildings.py",), network=True, isolated=False, args=lambda p: ["--no-enrich"],
          description="Overture buildings, roads, base, divisions (+ OSM snapshot boundary fallback) -> PMTiles"),
    Stage("dem", "fetch_dem.py", (), lambda p: [p.out_dir / "dem" / "dem_manifest.json"], network=True, isolated=False,
          description="Copernicus GLO-30 DEM, relief, slope, contours, terrain tiles"),
    Stage("osm", "enrich_osm_buildings.py", ("fetch",), _o("building_pois.json", "building_labels.geojson"),
          raw_inputs=lambda p: [REGION_OSM / "meta.json"],
          helpers=("fetch_bacolod.py", "score_poi_votes.py", "osm_snapshot.py"), network=True, isolated=False,
          description="OSM snapshot + Overture / Foursquare POIs matched to buildings"),
    Stage("place-meta", "export_place_meta.py", (), _o("place.json"),
          raw_inputs=lambda p: [p.overrides_dir() / "place.json"],
          description="place.json for the web app (view, presets, landmarks) + places.json index"),
    Stage("overrides", "apply_boundary_overrides.py", ("fetch",), _o("boundaries.geojson"),
          raw_inputs=lambda p: [p.overrides_dir() / "boundaries.json"],
          description="Hand corrections from overrides/<place>/"),
    Stage("analytics", "compute_barangay_analytics.py", ("overrides", "osm", "dem"), _o("barangay_analytics.json", "catchment_grid.json"),
          helpers=("enrich_osm_buildings.py", "fetch_bacolod.py", "parse_bir_zonal_values.py"), isolated=False,
          description="Per-barangay urban form, POIs, terrain; 250 m catchment grid"),
    Stage("zonal", "parse_bir_zonal_values.py", ("analytics",), _o("bir_zonal_values.json"), raw_inputs=_bir,
          applies=lambda p: bool(p.setting("bir")),
          description="BIR zonal values per barangay (only places with a workbook; see scripts/bir_pipeline.py)"),
    Stage("poi-votes", "score_poi_votes.py", ("osm", "analytics"), _o("building_pois.json"),
          helpers=("estimate_building_zonal_values.py", "parse_bir_zonal_values.py"),
          description="POI location trust votes"),
    Stage("hazards", "build_hazard_layers.py", ("overrides",), _o("hazards.geojson"), raw_inputs=_noah,
          description="Project NOAH flood and storm surge clipped to the place"),
    Stage("building-values", "estimate_building_zonal_values.py", ("zonal", "hazards", "dem"),
          _o("building_zonal.bin", "building_zonal.json", "building_hazard.bin", "building_hazard.json", "barangay_property.json"),
          helpers=("parse_bir_zonal_values.py", "enrich_osm_buildings.py", "compute_barangay_analytics.py"),
          description="Per-building zonal value, surge / elevation flags, barangay property totals"),
    Stage("transport", "fetch_osm_transport.py", ("fetch",), _o("transport_osm.json", "transit_routes.geojson"),
          raw_inputs=lambda p: [REGION_OSM / "meta.json"], helpers=("osm_snapshot.py",),
          description="OSM signals, stops and bus / jeepney routes"),
    Stage("demographics", "parse_psa_age_sex.py", ("overrides",), _o("barangay_demographics.json"), raw_inputs=_psa,
          helpers=("parse_bir_zonal_values.py",), description="PSA 2020 age bands per barangay"),
    Stage("demand", "build_barangay_demand.py", ("demographics",), _o("barangay_demand.json"),
          description="Trip purpose production per barangay"),
    Stage("network", "build_road_network.py", ("overrides", "demographics"),
          lambda p: [_state_dir(p) / "state.json", _state_dir(p) / "state.npz"],
          raw_inputs=_network_raw, isolated=False, applies=_builds_network,
          description="Road graph, zones, demand and mode calibration from the Geofabrik extract (trafficsim code)"),
    Stage("typology", "classify_barangays.py", ("analytics", "demographics", "network"), _o("barangay_typology.json"),
          description="Barangay area types (k-means)"),
    Stage("mobility", "export_trafficsim_network.py", ("analytics", "poi-votes", "demand", "typology", "transport", "dem", "network"),
          _o("mobility_network.bin", "mobility_zones.json", "mobility_buildings.bin", "mobility_buildings.json"),
          raw_inputs=_mobility_raw, helpers=("compute_barangay_analytics.py", "enrich_osm_buildings.py"), isolated=False,
          description="Simulation network, zones and building weights"),
    Stage("edge-streets", "export_edge_streets.py", ("mobility",), _o("mobility_edge_streets.json"),
          description="Street names per simulation edge"),
    Stage("landcover", "compute_landcover_stats.py", ("mobility", "analytics"), _o("barangay_landcover.json"), raw_inputs=_landcover,
          description="ESA WorldCover shares per barangay (runs after mobility, which rewrites boundaries)"),
    Stage("population", "estimate_building_population.py", ("mobility", "building-values", "landcover", "demographics"),
          _o("building_population.bin", "building_population.json"),
          description="Residents per building (census spread by home weight); population fields for choropleths"),
]
STAGE_BY_NAME = {s.name: s for s in STAGES}


# ---------------------------------------------------------------- fingerprints

def file_digest(path: Path) -> str:
    if not path.exists():
        return "missing"
    st = path.stat()
    if st.st_size > BIG_FILE:
        return f"size={st.st_size};mtime={st.st_mtime_ns}"
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Registry settings only one stage reads; other stages ignore them in their fingerprint, so tuning e.g. a
# hazard setting reruns the hazard stage (and its dependants), not everything.
STAGE_ONLY_SETTINGS: dict[str, set[str]] = {
    "hazards": {"hazard_simplify_deg", "hazard_clip_to_city", "hazard_serve_floods", "noah_province"},
    "dem": {"contour_interval_m", "contour_major_m", "dem_tif_public", "dem_grid", "terrain_bbox"},
    "zonal": {"bir"},
}
NEVER_FINGERPRINTED = {"status", "size_budget_mb"}


def settings_for(stage: Stage, place: Place) -> dict[str, Any]:
    hidden = set(NEVER_FINGERPRINTED)
    for name, keys in STAGE_ONLY_SETTINGS.items():
        if name != stage.name:
            hidden |= keys
    return {k: v for k, v in place.raw.items() if k not in hidden}


def fingerprint(stage: Stage, place: Place, dep_fps: dict[str, str]) -> str:
    h = hashlib.sha256()
    for code in (stage.script, "place.py", *stage.helpers):
        h.update(code.encode())
        h.update(file_digest(SCRIPTS / code).encode())
    h.update(json.dumps(settings_for(stage, place), sort_keys=True).encode())
    for raw in stage.raw_inputs(place):
        h.update(str(raw.relative_to(REPO_ROOT) if raw.is_relative_to(REPO_ROOT) else raw).encode())
        h.update(file_digest(raw).encode())
    for d in stage.deps:
        h.update(f"{d}={dep_fps.get(d, '')}".encode())
    h.update(" ".join(stage.args(place)).encode())
    return h.hexdigest()[:16]


def load_stamps(place: Place) -> dict[str, Any]:
    path = BUILD / place.slug / "stamps.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def save_stamps(place: Place, stamps: dict[str, Any]) -> None:
    path = BUILD / place.slug / "stamps.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(stamps, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- planning

@dataclass
class Decision:
    stage: Stage
    action: str  # run | skip | adopt | blocked
    reason: str
    fp: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def plan(place: Place, stamps: dict[str, Any], *, offline: bool, refresh: bool, force: set[str],
         selected: set[str] | None) -> list[Decision]:
    fps: dict[str, str] = {}
    decisions: list[Decision] = []
    for st in STAGES:
        fp = fingerprint(st, place, fps)
        prev = stamps.get(st.name, {})
        outputs_ok = all(o.exists() for o in st.outputs(place))
        in_scope = selected is None or st.name in selected
        if not st.applies(place):
            fps[st.name] = "n/a"
            decisions.append(Decision(st, "skip", "not used for this place", "n/a"))
            continue
        if not in_scope:
            # Out of scope: keep whatever is there and pass its recorded fingerprint on.
            fps[st.name] = prev.get("stored_fp", fp)
            decisions.append(Decision(st, "skip", "not selected", fps[st.name]))
            continue
        reasons = []
        if st.name in force:
            reasons.append("forced")
        if not outputs_ok:
            reasons.append("outputs missing")
        if prev.get("fp") != fp:
            reasons.append("inputs changed" if prev else "never run")
        net = st.is_network(place)
        if net and refresh:
            reasons.append("refresh")
        if net and (offline or not (refresh or st.name in force or not outputs_ok)):
            if outputs_ok:
                # Keep fetched data; adopt its stored fingerprint (or mint one on first adoption).
                stored = prev.get("stored_fp") or f"{fp}-adopted"
                fps[st.name] = stored
                why = "offline, using existing outputs" if offline else "network stage, outputs present"
                decisions.append(Decision(st, "adopt" if prev.get("fp") != fp else "skip", why, fp, {"stored_fp": stored}))
                continue
            if offline:
                fps[st.name] = fp
                decisions.append(Decision(st, "blocked", "offline and outputs missing", fp))
                continue
        if reasons:
            stored = fp
            decisions.append(Decision(st, "run", ", ".join(reasons), fp))
        else:
            stored = prev.get("stored_fp", fp)
            decisions.append(Decision(st, "skip", "up to date", fp))
        fps[st.name] = stored
    return decisions


# ---------------------------------------------------------------- running

def run_stage(st: Stage, place: Place) -> tuple[bool, float, str]:
    cmd = [sys.executable]
    if st.isolated:
        cmd.append("-I")
    cmd += [str(SCRIPTS / st.script), "--place", place.slug, *st.args(place)]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode == 0, time.time() - t0, out


REQUIRED_SETTINGS = ("bbox", "analysis_bbox", "terrain_bbox", "center", "barangays", "dem_grid", "osm_relation")


def missing_settings(place: Place) -> list[str]:
    return [k for k in REQUIRED_SETTINGS if place.setting(k) is None]


def run_place(place: Place, args: argparse.Namespace) -> bool:
    missing = missing_settings(place)
    if missing:
        print(f"\n== {place.display_name} ({place.slug}, {place.status}): not configured yet; "
              f"add {', '.join(missing)} to its entry in regions/negros-occidental.json")
        return False
    stamps = load_stamps(place)
    selected = None
    if args.only:
        selected = set(args.only)
    elif args.from_stage:
        names = [s.name for s in STAGES]
        selected = set(names[names.index(args.from_stage):])
    force = set(selected or STAGE_BY_NAME) if args.force else set()
    decisions = plan(place, stamps, offline=args.offline, refresh=args.refresh, force=force, selected=selected)
    print(f"\n== {place.display_name} ({place.slug}, {place.status})")
    ok = True
    log: list[dict[str, Any]] = []
    for d in decisions:
        tag = {"run": "RUN ", "skip": "skip", "adopt": "keep", "blocked": "BLOCK"}[d.action]
        print(f"  {tag} {d.stage.name:<16} {d.reason}")
        if args.dry_run or d.action == "skip":
            continue
        if args.stamp_only and d.action == "run":
            if not all(o.exists() for o in d.stage.outputs(place)):
                print("       outputs missing; not stamped")
                ok = False
                continue
            stamps[d.stage.name] = {"fp": d.fp, "stored_fp": d.fp, "stamped_at": now()}
            save_stamps(place, stamps)
            continue
        if d.action == "blocked":
            ok = False
            break
        if d.action == "adopt":
            stamps[d.stage.name] = {"fp": d.fp, "stored_fp": d.extra["stored_fp"], "adopted_at": now()}
            save_stamps(place, stamps)
            continue
        success, secs, out = run_stage(d.stage, place)
        tail = "\n".join(out.splitlines()[-6:])
        log.append({"stage": d.stage.name, "ok": success, "seconds": round(secs, 1), "output_tail": tail})
        if not success:
            print(f"       FAILED after {secs:.0f}s:\n" + "\n".join("       | " + l for l in out.splitlines()[-25:]))
            ok = False
            break
        stored = d.fp if not d.stage.is_network(place) else f"{d.fp}-{int(time.time())}"
        stamps[d.stage.name] = {"fp": d.fp, "stored_fp": stored, "ran_at": now(), "seconds": round(secs, 1)}
        save_stamps(place, stamps)
        print(f"       done in {secs:.0f}s" + (f" | {out.splitlines()[-1][:110]}" if out else ""))
    if args.dry_run:
        return ok
    qa = run_qa(place)
    qa["run_log"] = log
    (BUILD / place.slug).mkdir(parents=True, exist_ok=True)
    (BUILD / place.slug / "qa.json").write_text(json.dumps(qa, indent=2) + "\n", encoding="utf-8")
    print(f"  QA {'PASS' if qa['pass'] else 'FAIL'}: " + "; ".join(f"{c['check']} {'ok' if c['ok'] else 'FAIL'} ({c['detail']})" for c in qa["checks"]))
    return ok and qa["pass"]


def ensure_region_extract(args: argparse.Namespace) -> None:
    """Cut the province from the newest Geofabrik file once per new download (shared by every place)."""
    pbfs = sorted((REPO_ROOT / "data" / "osm" / "geofabrik").glob("philippines-*.osm.pbf"))
    if not pbfs:
        return
    stamp_path = BUILD / "_region" / "stamps.json"
    stamps = json.loads(stamp_path.read_text(encoding="utf-8")) if stamp_path.exists() else {}
    fp = hashlib.sha256((file_digest(pbfs[-1]) + file_digest(SCRIPTS / "extract_osm_region.py")).encode()).hexdigest()[:16]
    if stamps.get("osm-extract", {}).get("fp") == fp and (REGION_OSM / "meta.json").exists():
        return
    if (REGION_OSM / "meta.json").exists() and not stamps:
        # Extract made by hand (npm run data:osm-extract) before the pipeline tracked it: adopt it.
        stamps["osm-extract"] = {"fp": fp, "adopted_at": now()}
        stamp_path.parent.mkdir(parents=True, exist_ok=True)
        stamp_path.write_text(json.dumps(stamps, indent=2) + "\n", encoding="utf-8")
        return
    print(f"== province OSM extract from {pbfs[-1].name}")
    t = time.time()
    proc = subprocess.run([sys.executable, "-I", str(SCRIPTS / "extract_osm_region.py")], cwd=REPO_ROOT, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit("OSM extract failed:\n" + (proc.stdout + proc.stderr)[-2000:])
    stamps["osm-extract"] = {"fp": fp, "ran_at": now(), "seconds": round(time.time() - t, 1)}
    stamp_path.parent.mkdir(parents=True, exist_ok=True)
    stamp_path.write_text(json.dumps(stamps, indent=2) + "\n", encoding="utf-8")
    print(f"   done in {time.time() - t:.0f}s | {proc.stdout.strip().splitlines()[-1][:120]}")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- quality gates

QA_MAX_UNASSIGNED_KM2 = 0.5   # land inside the place but in no barangay (Bata was 4 km2)
QA_SEA_KM2 = 20.0             # larger unassigned pieces are open sea inside coastal city polygons


def run_qa(place: Place) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    out = place.out_dir
    missing = [str(o.relative_to(REPO_ROOT)) if o.is_relative_to(REPO_ROOT) else str(o)
               for st in STAGES if st.applies(place) for o in st.outputs(place) if not o.exists()]
    check("files", not missing, "all present" if not missing else f"missing {len(missing)}: {missing[:4]}")

    bpath = out / "boundaries.geojson"
    if bpath.exists():
        from apply_boundary_overrides import km2_per_deg2, unassigned_pieces

        fc = json.loads(bpath.read_text(encoding="utf-8"))
        brgys = [f["properties"] for f in fc["features"] if f["properties"].get("level") == "barangay"]
        n = sum(len(p.get("members") or [None]) for p in brgys)
        approx = sum(1 for p in brgys if str(p.get("boundary_source", "")).startswith("approximate"))
        combined = sum(len(p.get("members") or []) for p in brgys)
        check("barangay count", n == place.barangay_count,
              f"{n} of {place.barangay_count} (PSA)" + (f"; {approx} approximate outlines, {combined} in a combined zone" if approx else ""))
        k = km2_per_deg2(place.lat0)
        land_gaps = sorted((round(p.area * k, 3) for p in unassigned_pieces(fc) if p.area * k < QA_SEA_KM2), reverse=True)
        big = [g for g in land_gaps if g > QA_MAX_UNASSIGNED_KM2]
        check("unassigned land", not big, f"largest {land_gaps[0] if land_gaps else 0} km2, limit {QA_MAX_UNASSIGNED_KM2}")

    dpath = out / "barangay_demographics.json"
    if dpath.exists():
        demo = json.loads(dpath.read_text(encoding="utf-8"))
        miss = demo.get("missing", [])
        check("census match", not miss, "every barangay matched to PSA" if not miss else f"unmatched {miss[:5]}")

    sizes = {p.name: p.stat().st_size for p in out.rglob("*") if p.is_file()}
    total_mb = sum(sizes.values()) / 1e6
    budget = float(place.setting("size_budget_mb", 150))
    check("size", total_mb <= budget, f"{total_mb:.1f} MB of {budget:.0f} MB budget")
    return {"place": place.slug, "checked_at": now(), "pass": all(c["ok"] for c in checks), "checks": checks, "total_mb": round(total_mb, 1)}


# ---------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    who = ap.add_mutually_exclusive_group()
    who.add_argument("--place", action="append", help="place slug (repeatable)")
    who.add_argument("--all", action="store_true", help=f"every place with status {RUNNABLE_STATUSES}")
    ap.add_argument("--only", type=lambda s: s.split(","), help="comma-separated stage names")
    ap.add_argument("--from", dest="from_stage", choices=[s.name for s in STAGES], help="this stage and everything after it")
    ap.add_argument("--offline", action="store_true", help="never run network stages")
    ap.add_argument("--refresh", action="store_true", help="re-fetch network sources")
    ap.add_argument("--force", action="store_true", help="rerun the selected stages even if up to date")
    ap.add_argument("--dry-run", action="store_true", help="show the plan only")
    ap.add_argument("--stamp-only", action="store_true",
                    help="record the current outputs of the selected stages as up to date without running them "
                         "(after a change you have checked does not alter them)")
    ap.add_argument("--list", action="store_true", help="list stages and places")
    args = ap.parse_args()

    if args.only:
        unknown = [s for s in args.only if s not in STAGE_BY_NAME]
        if unknown:
            ap.error(f"unknown stage(s) {unknown}; see --list")
    if args.list:
        for st in STAGES:
            print(f"{st.name:<16} {'[net] ' if st.network else '      '}{st.description}")
        print()
        for p in all_places():
            print(f"{p.slug:<20} {p.status:<8} {p.kind:<13} {p.barangay_count:>3} barangays  {p.population_2020:>9,}")
        return 0

    if args.all:
        places = [p for p in all_places() if p.status in RUNNABLE_STATUSES]
    else:
        places = [get_place(s) for s in (args.place or [None])]
    failures = []
    if not args.dry_run and not args.list:
        ensure_region_extract(args)
    for place in places:
        try:
            if not run_place(place, args):
                failures.append(place.slug)
        except PlaceNotConfigured as exc:
            print(f"\n== {place.slug}: not configured: {exc}")
            failures.append(place.slug)
    if failures:
        print(f"\nFailed or blocked: {', '.join(failures)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
