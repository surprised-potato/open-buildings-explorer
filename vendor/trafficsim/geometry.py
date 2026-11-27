# File: geometry.py
"""Tk-free geometry helpers for the editing tools (all coordinates are (lat, lon) degrees).

Rotation/scaling is done in a local equirectangular frame (x = dlon*cos(lat0), y = dlat) so
shapes keep their proportions on screen instead of skewing at higher latitudes."""
import math
from typing import List, Sequence, Tuple

LatLon = Tuple[float, float]
EARTH_R_M = 6371008.8


def bbox_center(points: Sequence[LatLon]) -> LatLon:
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return ((min(lats) + max(lats)) / 2.0, (min(lons) + max(lons)) / 2.0)


def rotate_point(p: LatLon, center: LatLon, angle_deg: float) -> LatLon:
    """Rotate p about center; positive angle = counter-clockwise on a north-up map."""
    k = math.cos(math.radians(center[0]))
    x = (p[1] - center[1]) * k
    y = p[0] - center[0]
    a = math.radians(angle_deg)
    xr = x * math.cos(a) - y * math.sin(a)
    yr = x * math.sin(a) + y * math.cos(a)
    return (center[0] + yr, center[1] + (xr / k if abs(k) > 1e-12 else 0.0))


def rotate_points(points: Sequence[LatLon], center: LatLon, angle_deg: float) -> List[LatLon]:
    return [rotate_point(p, center, angle_deg) for p in points]


def translate_points(points: Sequence[LatLon], dlat: float, dlon: float) -> List[LatLon]:
    return [(p[0] + dlat, p[1] + dlon) for p in points]


def metres_to_deg(lat: float, east_m: float, north_m: float) -> Tuple[float, float]:
    """Returns (dlat, dlon) for a metric offset at the given latitude."""
    dlat = math.degrees(north_m / EARTH_R_M)
    dlon = math.degrees(east_m / (EARTH_R_M * max(math.cos(math.radians(lat)), 1e-9)))
    return dlat, dlon


def circle_polygon(center: LatLon, radius_m: float, n: int = 36) -> List[LatLon]:
    pts = []
    for i in range(n):
        ang = 2 * math.pi * i / n
        dlat, dlon = metres_to_deg(center[0], radius_m * math.cos(ang), radius_m * math.sin(ang))
        pts.append((center[0] + dlat, center[1] + dlon))
    return pts


def rect_polygon(p1: LatLon, p2: LatLon) -> List[LatLon]:
    """Axis-aligned (north-up) rectangle from two opposite corners."""
    (la1, lo1), (la2, lo2) = p1, p2
    return [(la1, lo1), (la1, lo2), (la2, lo2), (la2, lo1)]


def polygon_area_km2(polygon: Sequence[LatLon]) -> float:
    if len(polygon) < 3:
        return 0.0
    lat0 = sum(p[0] for p in polygon) / len(polygon)
    k = math.cos(math.radians(lat0))
    r_km = EARTH_R_M / 1000.0
    pts = [(math.radians(p[1]) * k * r_km, math.radians(p[0]) * r_km) for p in polygon]
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def dist_point_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """Euclidean distance from point P to segment AB (any consistent units, e.g. pixels)."""
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def nearest_segment(px: float, py: float, pts_xy: Sequence[Tuple[float, float]], closed: bool = False):
    """(distance, index of the segment's first vertex) of the polyline/polygon segment nearest P."""
    best = (float("inf"), -1)
    n = len(pts_xy)
    last = n if closed else n - 1
    for i in range(last):
        ax, ay = pts_xy[i]
        bx, by = pts_xy[(i + 1) % n]
        d = dist_point_segment(px, py, ax, ay, bx, by)
        if d < best[0]:
            best = (d, i)
    return best


def polyline_length_km(points: Sequence[LatLon]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        p1, p2 = math.radians(a[0]), math.radians(b[0])
        dphi = p2 - p1
        dl = math.radians(b[1] - a[1])
        h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * (EARTH_R_M / 1000.0) * math.asin(math.sqrt(h))
    return total
