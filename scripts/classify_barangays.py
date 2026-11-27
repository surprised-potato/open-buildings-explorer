#!/usr/bin/env python3
"""Group Bacolod's 61 barangays into area types.

Inputs : barangay_analytics.json (urban form, POIs), barangay_demographics.json (age bands),
         mobility_zones.json (jobs / students per zone)
Output : barangay_typology.json  {types: [...], barangays: {name: {type, features}}, summary}

Deterministic k-means (numpy, fixed seed) on z-scored features, then labels are assigned from each
cluster's centroid with fixed rules, so the labels are explainable rather than "cluster 3".
Used to label barangays in the UI and reports; purpose mixes come from the age model, not from here.
Run with `uv run python -I scripts/classify_barangays.py`.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from place import add_place_argument, current_place  # noqa: E402

PLACE = current_place()

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = PLACE.out_dir

K = 4
FEATURES = [
    "log_density",       # buildings per km2 (log)
    "coverage",          # built coverage %
    "commercial",        # commercial share of buildings %
    "log_poi_density",   # POIs per km2 (log)
    "jobs_per_res",      # zone jobs / residents
    "students_per_res",  # zone school seats / residents
    "young",             # share of residents aged 5-24
    "industrial",        # industrial share of buildings %
]

LABELS = {
    "core": "Urban core",
    "industrial": "Industrial / port",
    "suburban": "Suburban / low density",
    "residential": "Urban residential",
}


def feature_matrix(
    analytics: list[dict[str, Any]],
    demographics: dict[str, dict[str, Any]],
    zones: dict[str, dict[str, Any]],
) -> tuple[list[str], np.ndarray]:
    names: list[str] = []
    rows: list[list[float]] = []
    for a in analytics:
        name = a["name"]
        demo = demographics.get(name)
        zone = zones.get(name)
        if demo is None or zone is None:
            continue
        pop = max(1.0, float(demo["population"]))
        n_b = max(1.0, float(a["building_count"]))
        rows.append(
            [
                math.log1p(float(a["building_density_per_km2"])),
                float(a["built_coverage_pct"]),
                float(a["commercial_share_pct"]),
                math.log1p(float(a["poi_density_per_km2"])),
                float(zone.get("jobs") or 0.0) / pop,
                float(zone.get("students") or 0.0) / pop,
                (float(demo["age_5_14"]) + float(demo["age_15_24"])) / pop,
                100.0 * float(a["industrial_count"]) / n_b,
            ]
        )
        names.append(name)
    return names, np.asarray(rows, dtype=float)


def zscore(x: np.ndarray) -> np.ndarray:
    sd = x.std(axis=0)
    sd[sd < 1e-6] = 1.0  # constant (or numerically constant) feature carries no signal
    return (x - x.mean(axis=0)) / sd


def kmeans(x: np.ndarray, k: int, seed: int = 7, n_init: int = 30, iters: int = 100) -> np.ndarray:
    """Labels from the best of n_init k-means++ restarts (lowest inertia)."""
    rng = np.random.RandomState(seed)
    best_labels: np.ndarray | None = None
    best_inertia = math.inf
    n = len(x)
    for _ in range(n_init):
        centers = [x[rng.randint(n)]]
        for _ in range(1, k):
            d2 = np.min([((x - c) ** 2).sum(axis=1) for c in centers], axis=0)
            total = d2.sum()
            centers.append(x[rng.choice(n, p=d2 / total)] if total > 0 else x[rng.randint(n)])
        c = np.asarray(centers)
        labels = np.zeros(n, dtype=int)
        for _ in range(iters):
            dist = ((x[:, None, :] - c[None, :, :]) ** 2).sum(axis=2)
            new = dist.argmin(axis=1)
            if np.array_equal(new, labels) and _ > 0:
                break
            labels = new
            for j in range(k):
                members = x[labels == j]
                if len(members):
                    c[j] = members.mean(axis=0)
        inertia = float(((x - c[labels]) ** 2).sum())
        if inertia < best_inertia:
            best_inertia, best_labels = inertia, labels
    assert best_labels is not None
    return best_labels


def label_clusters(centroids: np.ndarray) -> dict[int, str]:
    """Assign each cluster one distinct label from its z-scored centroid, in priority order."""
    idx = {f: i for i, f in enumerate(FEATURES)}
    left = set(range(len(centroids)))
    out: dict[int, str] = {}

    def pick(score: np.ndarray, key: str) -> None:
        j = max(left, key=lambda c: score[c])
        out[j] = key
        left.discard(j)

    c = centroids
    pick(c[:, idx["industrial"]], "industrial")
    pick(c[:, idx["commercial"]] + c[:, idx["log_poi_density"]] + c[:, idx["jobs_per_res"]], "core")
    pick(-(c[:, idx["log_density"]] + c[:, idx["coverage"]]), "suburban")
    for j in left:
        out[j] = "residential"
    return out


def classify(
    names: list[str], x: np.ndarray, k: int = K, seed: int = 7
) -> dict[str, dict[str, Any]]:
    z = zscore(x)
    labels = kmeans(z, k, seed)
    centroids = np.asarray([z[labels == j].mean(axis=0) if (labels == j).any() else np.zeros(z.shape[1]) for j in range(k)])
    names_by_cluster = label_clusters(centroids)
    result: dict[str, dict[str, Any]] = {}
    for i, name in enumerate(names):
        key = names_by_cluster[int(labels[i])]
        result[name] = {
            "type": key,
            "label": LABELS[key],
            "features": {f: round(float(x[i, j]), 3) for j, f in enumerate(FEATURES)},
        }
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_place_argument(ap)
    ap.add_argument("--out", type=Path, default=OUT_DIR / "barangay_typology.json")
    args = ap.parse_args()

    analytics = json.loads((OUT_DIR / "barangay_analytics.json").read_text(encoding="utf-8"))["barangays"]
    demographics = json.loads((OUT_DIR / "barangay_demographics.json").read_text(encoding="utf-8"))["barangays"]
    zones = {z["name"]: z for z in json.loads((OUT_DIR / "mobility_zones.json").read_text(encoding="utf-8"))["zones"]}
    names, x = feature_matrix(analytics, demographics, zones)
    result = classify(names, x)

    counts: dict[str, int] = {}
    for rec in result.values():
        counts[rec["type"]] = counts.get(rec["type"], 0) + 1
    payload = {
        "types": [{"key": k, "label": v} for k, v in LABELS.items()],
        "features": FEATURES,
        "method": "k-means (k=4, seed 7) on z-scored features; labels from centroid rules",
        "summary": counts,
        "barangays": result,
    }
    args.out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    suburban = counts.get("suburban", 0)
    print(f"{len(result)} barangays: {counts}; non-suburban (urban-like) {len(result) - suburban} (TSSP 2023 reports 41 urban / 20 suburban)")


if __name__ == "__main__":
    sys.exit(main())
