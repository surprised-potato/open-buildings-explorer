"""Place (LGU) configuration shared by every pipeline script.

The registry lives in regions/<region>.json. A script picks its place from, in order:
`--place <slug>` on its command line, the PLACE environment variable, or the region default.
Module-level constants in the scripts are derived from the place at import time, so the
choice has to be known before import; that is why `--place` is read straight from sys.argv.
"""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
REGIONS_DIR = REPO_ROOT / "regions"
DEFAULT_REGION = "negros-occidental"
M_PER_DEG_LAT = 111_320.0

Bbox = tuple[float, float, float, float]  # west, south, east, north


class PlaceNotConfigured(RuntimeError):
    """The place is in the registry but lacks a setting this step needs."""


@dataclass(frozen=True)
class Place:
    slug: str
    name: str
    display_name: str
    psa_name: str
    psgc: str
    kind: str
    status: str
    province: str
    province_display: str
    population_2020: int
    barangay_count: int
    raw: dict[str, Any] = field(repr=False, compare=False)

    # ---- locations ----
    @property
    def out_dir(self) -> Path:
        return REPO_ROOT / "public" / "data" / self.slug

    @property
    def data_url_dir(self) -> str:
        """Path the web app uses, relative to its base URL."""
        return f"data/{self.slug}"

    @property
    def file_prefix(self) -> str:
        return str(self.raw.get("file_prefix", self.slug))

    def pmtiles(self, kind: str) -> Path:
        return self.out_dir / f"{self.file_prefix}_{kind}.pmtiles"

    def overrides_dir(self) -> Path:
        return REPO_ROOT / "overrides" / self.slug

    # ---- geometry ----
    def _need(self, key: str) -> Any:
        if self.raw.get(key) is None:
            raise PlaceNotConfigured(f"{self.slug}: registry setting '{key}' is not set yet")
        return self.raw[key]

    @property
    def bbox(self) -> Bbox:
        """Fetch extent for Overture/OSM queries (west, south, east, north)."""
        return tuple(self._need("bbox"))  # type: ignore[return-value]

    @property
    def analysis_bbox(self) -> Bbox:
        """Padded extent for DEM sampling, hazards and the population grid."""
        return tuple(self._need("analysis_bbox"))  # type: ignore[return-value]

    @property
    def terrain_bbox(self) -> Bbox:
        return tuple(self._need("terrain_bbox"))  # type: ignore[return-value]

    @property
    def center(self) -> tuple[float, float]:
        return tuple(self._need("center"))  # type: ignore[return-value]

    @property
    def lat0(self) -> float:
        """Reference latitude for local planar metre conversions."""
        return float(self.raw.get("lat0", self.center[1]))

    @property
    def m_per_deg_lon(self) -> float:
        return M_PER_DEG_LAT * math.cos(math.radians(self.lat0))

    @property
    def planar_lat(self) -> float:
        """Latitude for the building/POI planar projection. Bacolod keeps its historic 10.67 so
        regenerated outputs stay identical; new places use lat0."""
        return float(self.raw.get("planar_lat", self.lat0))

    def foreign_locality_suffixes(self) -> list[str]:
        """Locality names that mark a third-party POI as belonging somewhere else."""
        if self.raw.get("foreign_locality_suffixes"):
            return list(self.raw["foreign_locality_suffixes"])
        reg = load_region()
        own = {self.name.lower(), self.display_name.lower()}
        names = list(reg.get("national_foreign_localities", []))
        for e in reg["places"]:
            n = str(e["name"]).lower().replace(".", "")
            if n not in own and e["slug"] != self.slug:
                names.append(n)
        return sorted(set(names), key=names.index)

    @property
    def barangays(self) -> list[str]:
        return list(self._need("barangays"))

    @property
    def trafficsim_state(self) -> Path | None:
        """Calibrated external trafficsim state for this place (registry path, relative to the repo), or None."""
        value = self.raw.get("trafficsim_state_dir")
        if not value:
            return None
        path = Path(value)
        return path if path.is_absolute() else REPO_ROOT / path

    def setting(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)

    def need(self, key: str) -> Any:
        return self._need(key)


def load_region(region: str = DEFAULT_REGION) -> dict[str, Any]:
    return json.loads((REGIONS_DIR / f"{region}.json").read_text(encoding="utf-8"))


def place_from_entry(entry: dict[str, Any], region: dict[str, Any]) -> Place:
    return Place(
        slug=entry["slug"],
        name=entry["name"],
        display_name=entry.get("display_name", entry["name"]),
        psa_name=entry["psa_name"],
        psgc=entry["psgc"],
        kind=entry["kind"],
        status=entry["status"],
        province=region["province"],
        province_display=region.get("province_display", region["province"].title()),
        population_2020=int(entry.get("population_2020", 0)),
        barangay_count=int(entry.get("barangay_count", 0)),
        raw=entry,
    )


def all_places(region: str = DEFAULT_REGION) -> list[Place]:
    reg = load_region(region)
    return [place_from_entry(e, reg) for e in reg["places"]]


def get_place(slug: str | None = None, region: str = DEFAULT_REGION) -> Place:
    reg = load_region(region)
    slug = slug or reg["default_place"]
    for e in reg["places"]:
        if e["slug"] == slug:
            return place_from_entry(e, reg)
    known = ", ".join(e["slug"] for e in reg["places"])
    raise SystemExit(f"Unknown place '{slug}'. Known places: {known}")


def requested_slug(argv: list[str] | None = None) -> str | None:
    argv = sys.argv[1:] if argv is None else argv
    for i, a in enumerate(argv):
        if a == "--place" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--place="):
            return a.split("=", 1)[1]
    return os.environ.get("PLACE") or None


def current_place() -> Place:
    """The place this process works on (see module docstring)."""
    return get_place(requested_slug())


def add_place_argument(parser: Any) -> None:
    """Accept --place on a script's own argparse (the value is read earlier by current_place)."""
    parser.add_argument(
        "--place",
        default=None,
        help="LGU slug from regions/negros-occidental.json (default: PLACE env var, then bacolod)",
    )
