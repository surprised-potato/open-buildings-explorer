"""Write public/data/<place>/place.json (what the web app needs to open a place) and refresh the
index public/data/places.json of every place that has been built.

place.json = registry facts (name, centre, bbox, file prefix) + hand-curated view settings from
overrides/<place>/place.json (home view, camera presets, landmarks). Missing curated settings fall
back to a plain overview of the place.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import REPO_ROOT, Place, add_place_argument, all_places, current_place  # noqa: E402

PLACE = current_place()
INDEX = REPO_ROOT / "public" / "data" / "places.json"


def build_meta(place: Place, curated: dict[str, Any]) -> dict[str, Any]:
    center = list(place.center)
    home = curated.get("homeView") or {"center": center, "zoom": 13.5, "pitch": 50, "bearing": 0}
    presets = curated.get("cameraPresets") or [
        {"id": "overview", "label": f"{place.name} Overview", "center": center, "zoom": 12.5, "pitch": 45, "bearing": 0}
    ]
    return {
        "slug": place.slug,
        "name": place.name,
        "displayName": place.display_name,
        "kind": place.kind,
        "province": place.province_display,
        "psgc": place.psgc,
        "filePrefix": place.file_prefix,
        "center": center,
        "bbox": list(place.bbox),
        "barangayCount": place.barangay_count,
        "population2020": place.population_2020,
        "homeView": home,
        "cameraPresets": presets,
        "landmarks": curated.get("landmarks", []),
    }


def build_index(places: list[Place], root: Path) -> dict[str, Any]:
    out = []
    for p in places:
        meta_path = root / p.slug / "place.json"
        if not meta_path.exists():
            continue
        out.append({"slug": p.slug, "displayName": p.display_name, "kind": p.kind, "status": p.status,
                    "center": list(p.center), "bbox": list(p.bbox)})
    return {"places": out}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    args = ap.parse_args()
    del args
    curated_path = PLACE.overrides_dir() / "place.json"
    curated = json.loads(curated_path.read_text(encoding="utf-8")) if curated_path.exists() else {}
    PLACE.out_dir.mkdir(parents=True, exist_ok=True)
    (PLACE.out_dir / "place.json").write_text(json.dumps(build_meta(PLACE, curated), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    index = build_index(all_places(), INDEX.parent)
    INDEX.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"place.json for {PLACE.slug}; places.json lists {len(index['places'])} place(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
