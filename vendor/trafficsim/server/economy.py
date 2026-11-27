# File: server/economy.py
"""Economic activity per zone (jobs, school seats, commercial attraction), purpose-based trip generation,
and the multimodal setup (mode parameters -> per-mode network times/costs).

Data reality (see reports/Bacolod barangay demand data.md): no public barangay-level employment, enrolment or
business data exists for Bacolod. Spatial distribution therefore comes from OpenStreetMap activity counts per
barangay, scaled to city-level totals; real barangay data can replace it through CSV import."""
import csv
import io
import math
from typing import Dict, List, Optional, Tuple

import numpy as np

import osm_import
from engine import tiling, od as od_tools

# --------------------------------------------------------------------------- activity categories (OSM tags)
CATEGORIES = ["retail", "market", "food", "finance", "office", "gov", "kindergarten", "school", "college",
              "university", "hospital", "clinic", "industry", "lodging", "transport", "commerce_area"]

# jobs per feature: ASSUMPTIONS (relative weights only; totals are rescaled to city figures)
JOB_W = {"retail": 4, "market": 50, "food": 5, "finance": 12, "office": 10, "gov": 40, "kindergarten": 6, "school": 35,
         "college": 80, "university": 300, "hospital": 150, "clinic": 8, "industry": 30, "lodging": 15, "transport": 15,
         "commerce_area": 6}
# school seats per feature (relative; rescaled to the enrolment total)
STUDENT_W = {"kindergarten": 60, "school": 700, "college": 1500, "university": 4000}
# attraction of shopping / business / private trips (relative)
COMMERCE_W = {"retail": 3, "market": 25, "food": 2, "finance": 3, "office": 1, "gov": 5, "hospital": 12, "clinic": 3,
              "lodging": 2, "transport": 6, "commerce_area": 3, "school": 0.3, "college": 0.5, "university": 1}

ECON_DEFAULTS = {
    "jobs_total": 278392,        # 0.95 x 293,044 (PSA 2023 LFS labour force, Bacolod); assumed employment rate
    "students_total": 155524,    # DepEd Bacolod division, SY 2024-25 (third-party TeacherPH)
    "informal_share": 0.30,      # jobs spread by population (informal/home-based work that OSM does not show)
    "trips_per_person": 2.97,    # JICA Metro Cebu 2014 household survey (proxy: no Bacolod survey exists)
    "peak_share": 0.09,          # share of daily trips in the modelled peak hour (assumption, uncited)
    "purposes": {                # production-attraction pair shares from Cebu purposes: work 26 / school 19 / other 9
        "hbw": {"name": "Home-work", "share": 0.48, "beta": 1.3, "attr": "jobs"},
        "hbe": {"name": "Home-school", "share": 0.35, "beta": 1.8, "attr": "students"},
        "hbo": {"name": "Home-other", "share": 0.17, "beta": 1.5, "attr": "commerce"},
    },
    "period": "am",              # modelled hour: "am" (home -> destination dominates), "pm" (reverse) or "balanced"
    "floor_weight": 0.5,         # 0 = activity counts only, 1 = building floor area only (blend of the two shares)
    "enabled": False,
}
# share of a purpose's peak-hour flow that goes production -> attraction in the AM peak (PM uses 1 - value).
# ASSUMPTIONS (no Bacolod time-of-day survey): commute and school trips are strongly directional, other trips less so.
PA_AM = {"hbw": 0.85, "hbe": 0.85, "hbo": 0.55}


# floor area (per 1000 m2, relative weights; rescaled to the city totals like the count weights). ASSUMPTIONS.
JOB_F = {"retail": 25, "market": 30, "commerce_area": 20, "office": 40, "gov": 25, "hospital": 15, "clinic": 25, "school": 8,
         "kindergarten": 8, "college": 10, "university": 10, "industry": 5, "lodging": 10, "transport": 10, "food": 30, "finance": 40}
STUDENT_F = {"kindergarten": 20, "school": 25, "college": 30, "university": 30}
COMMERCE_F = {"retail": 3, "market": 4, "commerce_area": 3, "office": 1, "gov": 1.5, "hospital": 3, "clinic": 2, "lodging": 1.5,
              "transport": 1.5, "food": 3, "finance": 2, "school": 0.2, "college": 0.3, "university": 0.4}
BUILDING_CAT = {"retail": "retail", "supermarket": "market", "kiosk": "retail", "commercial": "commerce_area", "office": "office",
                "hospital": "hospital", "clinic": "clinic", "school": "school", "kindergarten": "kindergarten", "college": "college",
                "university": "university", "hotel": "lodging", "industrial": "industry", "warehouse": "industry",
                "civic": "gov", "government": "gov", "public": "gov", "train_station": "transport", "transportation": "transport"}


def classify(tags: dict) -> List[str]:
    """OSM tags -> list of activity categories (usually 0 or 1)."""
    out = []
    amen, shop = tags.get("amenity"), tags.get("shop")
    if amen == "marketplace" or shop in ("supermarket", "mall", "department_store", "wholesale"):
        out.append("market")
    elif shop:
        out.append("retail")
    if amen in ("restaurant", "fast_food", "cafe", "bar", "food_court"):
        out.append("food")
    if amen in ("bank", "bureau_de_change"):
        out.append("finance")
    if amen == "pharmacy":
        out.append("retail")
    if amen in ("townhall", "courthouse", "police", "post_office", "fire_station", "public_building"):
        out.append("gov")
    if amen == "kindergarten":
        out.append("kindergarten")
    elif amen == "school":
        out.append("school")
    elif amen == "college":
        out.append("college")
    elif amen == "university":
        out.append("university")
    if amen == "hospital":
        out.append("hospital")
    elif amen in ("clinic", "doctors", "dentist"):
        out.append("clinic")
    if "office" in tags:
        out.append("office")
    if tags.get("landuse") in ("commercial", "retail"):
        out.append("commerce_area")
    if tags.get("landuse") == "industrial" or "industrial" in tags or tags.get("man_made") == "works" or "craft" in tags:
        out.append("industry")
    if tags.get("tourism") in ("hotel", "guest_house", "hostel", "motel", "resort"):
        out.append("lodging")
    if amen in ("bus_station", "ferry_terminal"):
        out.append("transport")
    return out


def poi_query(bbox) -> str:
    box = "(%.5f,%.5f,%.5f,%.5f)" % tuple(bbox)
    amen = ("marketplace|restaurant|fast_food|cafe|bar|food_court|bank|bureau_de_change|pharmacy|townhall|courthouse|police|"
            "post_office|fire_station|kindergarten|school|college|university|hospital|clinic|doctors|dentist|bus_station|ferry_terminal")
    return ("[out:json][timeout:180];("
            f'nwr["shop"]{box};nwr["amenity"~"^({amen})$"]{box};nwr["office"]{box};'
            f'nwr["landuse"~"^(commercial|retail|industrial)$"]{box};nwr["industrial"]{box};'
            f'nwr["tourism"~"^(hotel|guest_house|hostel|motel|resort)$"]{box};nwr["man_made"="works"]{box};nwr["craft"]{box};'
            ");out center tags;")


def building_query(bbox) -> str:
    box = "(%.5f,%.5f,%.5f,%.5f)" % tuple(bbox)
    kinds = "|".join(BUILDING_CAT)
    return f'[out:json][timeout:180];way["building"~"^({kinds})$"]{box};out tags geom;'


def building_floor(el: dict) -> Optional[Tuple[str, float, float, float]]:
    """Building way -> (category, floor area m2, lat, lon) using footprint x levels (default 1, capped at 30)."""
    cat = BUILDING_CAT.get((el.get("tags") or {}).get("building"))
    g = el.get("geometry") or []
    if not cat or len(g) < 4:
        return None
    la0 = sum(p["lat"] for p in g) / len(g)
    kx, ky = 111320.0 * math.cos(math.radians(la0)), 110540.0
    a = 0.0
    for p, q in zip(g, g[1:]):
        a += (p["lon"] * kx) * (q["lat"] * ky) - (q["lon"] * kx) * (p["lat"] * ky)
    area = abs(a) / 2.0
    try:
        lv = float(str((el["tags"]).get("building:levels", "1")).split(";")[0])
    except ValueError:
        lv = 1.0
    lv = min(max(lv, 1.0), 30.0)
    return cat, area * lv, la0, sum(p["lon"] for p in g) / len(g)


def floor_by_zone(elements: List[dict], zones: List[dict]) -> Dict[str, Dict[str, float]]:
    """Floor area (m2) per activity category per zone, from building footprints (centroid decides the zone)."""
    polys = [(z["id"], z["polygon"]) for z in zones if len(z.get("polygon", [])) >= 3]
    out = {z["id"]: {} for z in zones}
    if not polys:
        return out
    boxes = np.array([[min(p[0] for p in poly), min(p[1] for p in poly), max(p[0] for p in poly), max(p[1] for p in poly)] for _, poly in polys])
    for el in elements:
        b = building_floor(el)
        if not b:
            continue
        cat, m2, la, lo = b
        for ci in np.flatnonzero((boxes[:, 0] <= la) & (la <= boxes[:, 2]) & (boxes[:, 1] <= lo) & (lo <= boxes[:, 3])):
            zid, poly = polys[ci]
            if osm_import.point_in_polygon(la, lo, poly):
                out[zid][cat] = out[zid].get(cat, 0.0) + m2
                break
    return out


def fetch_pois(bbox, tile_km: float = 3.0, progress=None, cancel=None, workers: int = 4, retries: int = 2,
               timeout: int = 70, query_fn=None, **kw):
    """Activity features (nodes + way/relation centres) in the bbox: tiled, cached per tile, fetched in parallel and
    de-duplicated. Tiles that still fail after the retries are skipped and reported (cached tiles are kept, so running
    again only retries the missing ones). Returns (elements, failed_tiles, n_tiles)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    tiles = tiling.tile_bboxes(tuple(bbox), tile_km)
    results, failed, done = [], [], 0

    def one(t):
        if cancel and cancel():
            return t, None, "cancelled"
        try:
            return t, tiling.query_cached((query_fn or poi_query)(t), retries=retries, timeout=timeout, **kw), None
        except Exception as e:
            return t, None, str(e)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(one, t) for t in tiles]
        for f in as_completed(futs):
            t, data, err = f.result()
            done += 1
            if err == "cancelled":
                for g in futs:
                    g.cancel()
                raise osm_import.OSMImportError("Cancelled")
            if data is None:
                failed.append(t)
            else:
                results.append(data)
            if progress:
                progress(done, len(tiles), len(failed))
    seen, out = set(), []
    for data in results:
        for el in data.get("elements", []):
            key = (el.get("type"), el.get("id"))
            if key not in seen:
                seen.add(key)
                out.append(el)
    return out, failed, len(tiles)


def count_by_zone(elements: List[dict], zones: List[dict]) -> Dict[str, Dict[str, int]]:
    """Category counts per zone id (a feature belongs to the first zone polygon containing its point)."""
    polys = [(z["id"], z["polygon"]) for z in zones if len(z.get("polygon", [])) >= 3]
    boxes = np.array([[min(p[0] for p in poly), min(p[1] for p in poly), max(p[0] for p in poly), max(p[1] for p in poly)] for _, poly in polys])
    counts = {z["id"]: {} for z in zones}
    if not polys:
        return counts
    for el in elements:
        if el.get("type") == "node":
            la, lo = el.get("lat"), el.get("lon")
        else:
            c = el.get("center") or {}
            la, lo = c.get("lat"), c.get("lon")
        if la is None or lo is None:
            continue
        cats = classify(el.get("tags", {}))
        if not cats:
            continue
        cand = np.flatnonzero((boxes[:, 0] <= la) & (la <= boxes[:, 2]) & (boxes[:, 1] <= lo) & (lo <= boxes[:, 3]))
        for ci in cand:
            zid, poly = polys[ci]
            if osm_import.point_in_polygon(la, lo, poly):
                for cat in cats:
                    counts[zid][cat] = counts[zid].get(cat, 0) + 1
                break
    return counts


# --------------------------------------------------------------------------- allocation to city totals
def allocate(zones: List[dict], pops: Dict[str, float], params: dict) -> dict:
    """Fill z['jobs'], z['students'], z['commerce'] from OSM counts (z['poi']) scaled to the city totals,
    then apply CSV overrides (z['override']). pops: zone id -> population (census or estimate)."""
    have_poi = any(z.get("poi") for z in zones)
    n = len(zones)
    pop = np.array([max(pops.get(z["id"], 0.0), 0.0) for z in zones])
    pop_share = pop / pop.sum() if pop.sum() > 0 else np.full(n, 1.0 / max(n, 1))

    def weighted(w):
        return np.array([sum(w.get(c, 0.0) * cnt for c, cnt in (z.get("poi") or {}).items()) for z in zones])

    def share(x, floor=0.002):
        s = x / x.sum() if x.sum() > 0 else pop_share.copy()
        s = np.maximum(s, floor)
        return s / s.sum()

    have_floor = any(z.get("floor") for z in zones)
    fw = min(max(params.get("floor_weight", 0.5), 0.0), 1.0) if have_floor else 0.0

    def fweighted(w):
        return np.array([sum(w.get(c, 0.0) * m2 / 1000.0 for c, m2 in (z.get("floor") or {}).items()) for z in zones])

    def blend(count_w, floor_w, floor=0.002):
        s_c = share(weighted(count_w), floor) if have_poi else None
        s_f = share(fweighted(floor_w), floor) if have_floor else None
        if s_c is None and s_f is None:
            return None
        if s_c is None:
            return s_f
        return s_c if s_f is None else (1 - fw) * s_c + fw * s_f

    informal = min(max(params.get("informal_share", 0.3), 0.0), 1.0)
    bj, bs, bc = blend(JOB_W, JOB_F), blend(STUDENT_W, STUDENT_F, 0.0005), blend(COMMERCE_W, COMMERCE_F)
    jobs_share = (1 - informal) * bj + informal * pop_share if bj is not None else pop_share
    stud_share = bs if bs is not None else pop_share
    com_share = 0.8 * bc + 0.2 * pop_share if bc is not None else pop_share
    jobs = jobs_share * params["jobs_total"]
    students = stud_share * params["students_total"]
    commerce = com_share * 100.0                                  # index points (sum 100)
    over = 0
    for i, z in enumerate(zones):
        z["jobs"], z["students"], z["commerce"] = float(jobs[i]), float(students[i]), float(commerce[i])
        o = z.get("override") or {}
        for k in ("jobs", "students", "commerce"):
            if o.get(k) is not None:
                z[k] = float(o[k]); over += 1
    return {"has_poi": have_poi, "has_floor": have_floor, "overrides_applied": over, "jobs": float(sum(z["jobs"] for z in zones)),
            "students": float(sum(z["students"] for z in zones))}


def import_csv(zones: List[dict], text: str, key_fn) -> dict:
    """CSV with a `name` or `psgc` column and any of: pop, jobs, students, commerce, income_index.
    Values land in z['override'] and win over estimates. Returns a match report."""
    rows = list(csv.DictReader(io.StringIO("\n".join(l for l in text.splitlines() if l.strip() and not l.startswith("#")))))
    by_name = {key_fn(z["name"]): z for z in zones}
    by_psgc = {z["psgc"]: z for z in zones if z.get("psgc")}
    fields = ("pop", "jobs", "students", "commerce", "income_index")
    matched, missed = 0, []
    for r in rows:
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in r.items()}
        z = by_psgc.get(r.get("psgc", "")) or by_name.get(key_fn(r.get("name", "")))
        if z is None:
            missed.append(r.get("name") or r.get("psgc") or "?")
            continue
        o = z.setdefault("override", {})
        for k in fields:
            if r.get(k, "") != "":
                try:
                    o[k] = float(r[k].replace(",", ""))
                except ValueError:
                    pass
        if o.get("pop") is not None:
            z["pop"] = o["pop"]; z["pop_src"] = "CSV import"; z["pop_year"] = None
        matched += 1
    return {"rows": len(rows), "matched": matched, "unmatched": missed}


# --------------------------------------------------------------------------- purpose-based trip generation
def transpose(od: Dict[str, Dict[str, float]]) -> Dict[str, Dict[str, float]]:
    out: Dict[str, Dict[str, float]] = {}
    for o, ds in od.items():
        for d, t in ds.items():
            out.setdefault(d, {})[o] = t
    return out


def generate_od(zone_ids: List[str], coords, pop, attrs: Dict[str, List[float]], params: dict):
    """Home-based purposes by gravity model; each production-attraction pair makes an outbound and a return trip.
    Returns (od_peak_person_trips, by_purpose_daily, summary)."""
    pop = np.asarray(pop, dtype=float)
    total_daily = float(pop.sum()) * params["trips_per_person"]
    pairs_total = total_daily / 2.0
    by_purpose = {}
    for key, pu in params["purposes"].items():
        A = np.maximum(np.asarray(attrs[pu["attr"]], dtype=float), 1e-9)
        pa = od_tools.gravity_od(zone_ids, coords, pairs_total * pu["share"], productions=pop, attractions=A, beta=pu["beta"])
        by_purpose[key + "_pa"] = pa
        daily = {}
        for src in (pa, transpose(pa)):
            for o, ds in src.items():
                for d, t in ds.items():
                    daily.setdefault(o, {})[d] = daily.get(o, {}).get(d, 0.0) + t
        by_purpose[key] = daily
    k = params["peak_share"]
    period = params.get("period", "am")
    od = {}
    for key, pu in params["purposes"].items():
        pa_am = float(pu.get("pa_am", PA_AM.get(key, 0.5)))
        f = pa_am if period == "am" else (1.0 - pa_am) if period == "pm" else 0.5
        pa = by_purpose.pop(key + "_pa")
        for src, w in ((pa, 2 * f), (transpose(pa), 2 * (1 - f))):      # a pair = 2 daily trips
            for o, ds in src.items():
                row = od.setdefault(o, {})
                for d, t in ds.items():
                    row[d] = row.get(d, 0.0) + t * k * w
    summary = {"daily_person_trips": total_daily, "peak_person_trips": total_daily * k,
               "period": period, "by_purpose": {key: total_daily * pu["share"] for key, pu in params["purposes"].items()}}
    return od, by_purpose, summary


# --------------------------------------------------------------------------- modes
# ASSUMPTIONS (no Bacolod mode data exists): editable in the UI; targets are used to calibrate the constants.
DEFAULT_MODES = [
    {"id": "walk", "name": "Walk", "fixed_kmh": 4.5, "cost_per_km": 0.0, "occupancy": 1.0, "pcu": 0.0, "congests": False, "asc": 0.0, "target": 0.18},
    {"id": "motorcycle", "name": "Motorcycle", "speed_factor": 0.9, "cap_kmh": 60, "cost_per_km": 3.5, "occupancy": 1.3, "pcu": 0.4, "asc": -1.0, "target": 0.25},
    {"id": "tricycle", "name": "Tricycle", "speed_factor": 0.5, "cap_kmh": 25, "ban_above_kmh": 55, "cost_per_km": 8.0, "occupancy": 2.2, "pcu": 0.6, "asc": -1.5, "target": 0.10},
    {"id": "car", "name": "Car", "speed_factor": 0.95, "cap_kmh": 80, "cost_per_km": 9.0, "occupancy": 1.6, "pcu": 1.0, "asc": -2.0, "target": 0.14},
    {"id": "puv", "name": "Jeepney / bus", "speed_factor": 0.6, "cap_kmh": 40, "cost_per_km": 2.4, "occupancy": 12.0, "pcu": 2.0, "asc": -1.5, "target": 0.33},
]
DEFAULT_B_COST, DEFAULT_B_DUR = -0.04, -0.05      # per peso, per minute (value of time = 75 pesos/hour)
CLOSED_T = 1e6


def mode_objects(cfg: List[dict], b_cost: float, b_dur: float) -> dict:
    from data_structures import Mode
    out = {}
    for c in cfg:
        out[c["id"]] = Mode(id=c["id"], name=c["name"], beta_cost=b_cost, beta_duration=b_dur, asc=float(c.get("asc", 0.0)),
                            veh_factor=float(c.get("pcu", 1.0)) / max(float(c.get("occupancy", 1.0)), 1e-6),
                            congests=bool(c.get("congests", True)))
    return out


def build_mode_arrays(length, t0_ref, closed, cfg: List[dict]) -> Tuple[Dict[str, np.ndarray], Dict[str, np.ndarray]]:
    """Per-mode free-flow minutes and monetary cost per edge from the car-equivalent time `t0_ref`."""
    length = np.asarray(length, dtype=float)
    car_kmh = length / np.maximum(np.asarray(t0_ref, dtype=float), 1e-6) * 60.0
    closed_mask = np.zeros(len(length), dtype=bool)
    if closed:
        closed_mask[list(closed)] = True
    t0, cost = {}, {}
    for c in cfg:
        if c.get("fixed_kmh"):
            v = np.full(len(length), float(c["fixed_kmh"]))
        else:
            v = np.minimum(car_kmh * float(c.get("speed_factor", 1.0)), float(c.get("cap_kmh", 1e9)))
        t = length / np.maximum(v, 0.5) * 60.0
        if c.get("ban_above_kmh"):
            t = np.where(car_kmh > float(c["ban_above_kmh"]), CLOSED_T, t)
        t0[c["id"]] = np.where(closed_mask, CLOSED_T, t)
        cost[c["id"]] = length * float(c.get("cost_per_km", 0.0))
    return t0, cost
