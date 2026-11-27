/** Per-building hazard flags (building_hazard.bin, written by scripts/estimate_building_zonal_values.py).
 *  One byte per building, ids sorted as 16-byte UUIDs: bits 0-2 lowest storm-surge advisory reaching it
 *  (0 none, 1-4), bit 3 elevation below the low-lying threshold. */

export const BUILDING_HAZARD_MAGIC = 0x44485a42;
export const LOW_LYING_BIT = 8;

export interface BuildingHazardMeta {
  surgeLabels: string[];
  lowLyingM: number;
  source?: string;
  note?: string;
}

export interface BuildingHazardTable {
  n: number;
  ids: Uint8Array;
  values: Uint8Array;
  meta: BuildingHazardMeta;
}

export interface BuildingHazard {
  /** 0 not reached, 1-4 lowest surge advisory (2-3 m ... over 5 m) that reaches the building. */
  surgeLevel: number;
  surgeLabel: string;
  lowLying: boolean;
  lowLyingM: number;
}

export function parseBuildingHazard(buf: ArrayBuffer, meta: BuildingHazardMeta): BuildingHazardTable {
  const head = new Uint32Array(buf, 0, 4);
  if (head[0] !== BUILDING_HAZARD_MAGIC) throw new Error('Bad building_hazard.bin magic');
  const n = head[2];
  return {
    n,
    ids: new Uint8Array(buf, 16, n * 16),
    values: new Uint8Array(buf, 16 + n * 16, n),
    meta,
  };
}

function uuidBytes(id: string): Uint8Array | null {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function lookupBuildingHazard(table: BuildingHazardTable, gersId: string): BuildingHazard | null {
  const key = uuidBytes(gersId);
  if (!key) return null;
  let lo = 0;
  let hi = table.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const o = mid * 16;
    let cmp = 0;
    for (let i = 0; i < 16 && cmp === 0; i += 1) cmp = table.ids[o + i] - key[i];
    if (cmp === 0) {
      const v = table.values[mid];
      const surgeLevel = v & 7;
      return {
        surgeLevel,
        surgeLabel: table.meta.surgeLabels[surgeLevel] ?? '',
        lowLying: (v & LOW_LYING_BIT) !== 0,
        lowLyingM: table.meta.lowLyingM,
      };
    }
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

let cached: Promise<BuildingHazardTable | null> | null = null;

export function loadBuildingHazard(base: string): Promise<BuildingHazardTable | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const [b, j] = await Promise.all([
          fetch(`${base}data/bacolod/building_hazard.bin`),
          fetch(`${base}data/bacolod/building_hazard.json`),
        ]);
        if (!b.ok || !j.ok) return null;
        return parseBuildingHazard(await b.arrayBuffer(), (await j.json()) as BuildingHazardMeta);
      } catch {
        return null;
      }
    })();
  }
  return cached;
}
