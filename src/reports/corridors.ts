/** Street-level roll-up of the live mobility simulation (edge names from mobility_edge_streets.json). */

export const NO_STREET = 0xffff;

export interface EdgeStreets {
  names: string[];
  edge: number[];
}

export interface EdgeLoad {
  agents: ArrayLike<number>;
  pcu: ArrayLike<number>;
  vc: ArrayLike<number>;
  speedRatio: ArrayLike<number>;
}

export interface CorridorRow {
  key: string;
  name: string;
  edges: number;
  lengthKm: number;
  /** Simulated agents on the street right now (sampled, not the represented population). */
  agents: number;
  /** Smoothed passenger-car-equivalents on the street, scaled to the represented population. */
  pcu: number;
  /** Length-weighted volume/capacity. */
  vcMean: number;
  vcMax: number;
  /** Length-weighted car speed as a share of free flow. */
  speedRatio: number;
}

export interface CorridorSnapshot {
  rows: CorridorRow[];
  takenAt: number;
}

/** "C. L. Montelibano Avenue" and "C.L. Montelibano Avenue" must be one street. */
export function streetKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function aggregateCorridors(
  streets: EdgeStreets,
  edgeLenKm: ArrayLike<number>,
  load: EdgeLoad
): CorridorRow[] {
  const acc = new Map<string, CorridorRow & { vcLen: number; spLen: number; spellings: Map<string, number> }>();
  const n = Math.min(streets.edge.length, edgeLenKm.length);
  for (let e = 0; e < n; e += 1) {
    const si = streets.edge[e];
    if (si === NO_STREET || si >= streets.names.length) continue;
    const raw = streets.names[si];
    const key = streetKey(raw);
    let r = acc.get(key);
    if (!r) {
      r = {
        key, name: raw, edges: 0, lengthKm: 0, agents: 0, pcu: 0, vcMean: 0, vcMax: 0, speedRatio: 0,
        vcLen: 0, spLen: 0, spellings: new Map(),
      };
      acc.set(key, r);
    }
    const len = edgeLenKm[e];
    r.edges += 1;
    r.lengthKm += len;
    r.agents += load.agents[e];
    r.pcu += load.pcu[e];
    r.vcLen += load.vc[e] * len;
    r.spLen += load.speedRatio[e] * len;
    if (load.vc[e] > r.vcMax) r.vcMax = load.vc[e];
    r.spellings.set(raw, (r.spellings.get(raw) ?? 0) + len);
  }
  return [...acc.values()].map((r) => {
    const best = [...r.spellings.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? r.name;
    return {
      key: r.key, name: best, edges: r.edges, lengthKm: r.lengthKm, agents: r.agents, pcu: r.pcu,
      vcMean: r.lengthKm > 0 ? r.vcLen / r.lengthKm : 0,
      vcMax: r.vcMax,
      speedRatio: r.lengthKm > 0 ? r.spLen / r.lengthKm : 1,
    };
  });
}

/** Find the street whose normalised name contains `query` and carries the most length. */
export function findStreet(rows: CorridorRow[], query: string): CorridorRow | null {
  const q = streetKey(query);
  if (!q) return null;
  return rows.filter((r) => r.key.includes(q)).sort((a, b) => b.lengthKm - a.lengthKm)[0] ?? null;
}

let cached: Promise<EdgeStreets | null> | null = null;

export function loadEdgeStreets(base: string): Promise<EdgeStreets | null> {
  if (!cached) {
    cached = fetch(`${base}data/bacolod/mobility_edge_streets.json`)
      .then((r) => (r.ok ? (r.json() as Promise<EdgeStreets>) : null))
      .catch(() => null);
  }
  return cached;
}
