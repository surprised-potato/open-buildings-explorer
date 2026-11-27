# File: server/store.py
"""Persist the server project (network, geometry, zones, OD, results) so a restart keeps the loaded city.
Layout: <dir>/state.npz (arrays) + <dir>/state.json (ids, zones, OD, modes). Writes are atomic."""
import json
import os
from dataclasses import asdict

import numpy as np

from data_structures import Mode
from engine.network import FastNetwork

DEFAULT_DIR = os.environ.get("TRAFFICSIM_STATE") or os.path.join(os.path.expanduser("~"), ".cache", "trafficsim", "project")


def save(P, directory: str = DEFAULT_DIR) -> bool:
    with P.lock:
        net = P.net
        if net is None:
            return False
        os.makedirs(directory, exist_ok=True)
        coords, offs = P.geometry_arrays()
        arr = {"lat": net.lat, "lon": net.lon, "is_zone": net.is_zone, "src": net.src, "dst": net.dst,
               "length": net.length, "capacity": net.capacity, "t0_ref": net.t0_ref,
               "g_coords": coords, "g_offs": offs}
        for m, a in net.t0.items():
            arr[f"t0:{m}"] = a
        for m, a in net.cost.items():
            arr[f"cost:{m}"] = a
        for m, a in (P.flows or {}).items():
            arr[f"flow:{m}"] = a
        for m, a in (P.times or {}).items():
            arr[f"time:{m}"] = a
        meta = {"name": P.name, "node_ids": net.node_ids, "edge_ids": net.edge_ids, "boundary": P.boundary,
                "zones": [{**z, "polygon": [list(p) for p in z["polygon"]]} for z in P.zones],
                "od": P.od, "closed": sorted(P.closed), "od_params": P.od_params, "econ": P.econ, "mode_cfg": P.mode_cfg, "b_cost": P.b_cost, "b_dur": P.b_dur, "modes": {k: asdict(v) for k, v in P.modes.items()}}
        tmp_npz, tmp_json = os.path.join(directory, "state.tmp.npz"), os.path.join(directory, "state.tmp.json")
        np.savez(tmp_npz, **arr)
        with open(tmp_json, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        os.replace(tmp_npz, os.path.join(directory, "state.npz"))
        os.replace(tmp_json, os.path.join(directory, "state.json"))
        return True


def load(P, directory: str = DEFAULT_DIR) -> bool:
    jp, zp = os.path.join(directory, "state.json"), os.path.join(directory, "state.npz")
    if not (os.path.exists(jp) and os.path.exists(zp)):
        return False
    with open(jp, "r", encoding="utf-8") as f:
        meta = json.load(f)
    z = np.load(zp)
    modes = {k: Mode(**v) for k, v in meta["modes"].items()}
    t0 = {k[3:]: z[k] for k in z.files if k.startswith("t0:")}
    cost = {k[5:]: z[k] for k in z.files if k.startswith("cost:")}
    net = FastNetwork(meta["node_ids"], z["lat"], z["lon"], z["is_zone"], meta["edge_ids"], z["src"], z["dst"],
                      z["length"], z["capacity"], t0, cost, t0_ref=z["t0_ref"])
    coords, offs = z["g_coords"], z["g_offs"]
    geom = []
    for j in range(net.n_edges):
        seg = coords[offs[j]:offs[j + 1]]
        geom.append(seg)
    with P.lock:
        P.modes = modes
        P.set_network(net, geom, meta["name"])
        P.boundary = meta.get("boundary", [])
        P.zones = [{**zn, "polygon": [tuple(p) for p in zn["polygon"]]} for zn in meta["zones"]]
        P.od = meta.get("od", {})
        P.closed = set(meta.get("closed", []))
        P.od_params = tuple(meta["od_params"]) if meta.get("od_params") else None
        if meta.get("econ"):
            import copy
            from server import economy
            P.econ = {**copy.deepcopy(economy.ECON_DEFAULTS), **meta["econ"]}
        P.mode_cfg, P.b_cost, P.b_dur = meta.get("mode_cfg"), meta.get("b_cost", P.b_cost), meta.get("b_dur", P.b_dur)
        if P.mode_cfg:
            from server import economy as _e
            P.modes = _e.mode_objects(P.mode_cfg, P.b_cost, P.b_dur)
            P.prepare_modes()
        fl = {k[5:]: z[k] for k in z.files if k.startswith("flow:")}
        tm = {k[5:]: z[k] for k in z.files if k.startswith("time:")}
        P.flows, P.times = (fl or None), (tm or None)
    return True
