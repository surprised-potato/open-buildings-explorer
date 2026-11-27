/** Estimated residents per building (building_population.bin, written by
 *  scripts/estimate_building_population.py): each barangay's PSA 2020 population spread over its buildings
 *  by the simulation's home weights. Ids are sorted 16-byte UUIDs; lookup is a binary search. */

import { placeFile } from './place';

export const BUILDING_POPULATION_MAGIC = 0x504f5042;
export const AGE_BAND_LABELS: Record<string, string> = {
  age_0_4: 'Under 5',
  age_5_14: '5–14',
  age_15_24: '15–24',
  age_25_59: '25–59',
  age_60_plus: '60+',
};

export interface BarangayPopulation {
  population: number;
  buildings: number;
  buildings_with_residents: number;
  age_shares: Record<string, number>;
  /** Residents by lowest storm-surge advisory reaching their building: [none, 2-3 m, 3-4 m, 4-5 m, >5 m]. */
  surge_residents: number[];
}

export interface BuildingPopulationMeta {
  source: string;
  method: string;
  note: string;
  residentScale: number;
  barangays: string[];
  ageBands: string[];
  surgeLabels: string[];
  perBarangay: Record<string, BarangayPopulation>;
  population: number;
  placed: number;
  unplacedPopulation: number;
}

export interface BuildingPopulationTable {
  n: number;
  ids: Uint8Array;
  residents: Uint16Array;
  barangay: Uint16Array;
  meta: BuildingPopulationMeta;
}

export interface BuildingPopulation {
  residents: number;
  barangay: string | null;
  /** Residents by age band (the barangay's age mix applied to this building). */
  byAge: Array<{ band: string; label: string; count: number }>;
}

export function parseBuildingPopulation(buf: ArrayBuffer, meta: BuildingPopulationMeta): BuildingPopulationTable {
  const head = new Uint32Array(buf, 0, 4);
  if (head[0] !== BUILDING_POPULATION_MAGIC) throw new Error('Bad building_population.bin magic');
  const n = head[2];
  const idsEnd = 16 + n * 16;
  // u16 arrays start right after the ids (16 + 16n is always 2-byte aligned).
  return {
    n,
    ids: new Uint8Array(buf, 16, n * 16),
    residents: new Uint16Array(buf.slice(idsEnd, idsEnd + n * 2)),
    barangay: new Uint16Array(buf.slice(idsEnd + n * 2, idsEnd + n * 4)),
    meta,
  };
}

export function uuidBytes(id: string): Uint8Array | null {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" for entry i (the building tiles' feature id). */
export function idAt(table: BuildingPopulationTable, i: number): string {
  let hex = '';
  for (let k = 0; k < 16; k += 1) hex += table.ids[i * 16 + k].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function residentsAt(table: BuildingPopulationTable, i: number): number {
  return table.residents[i] / table.meta.residentScale;
}

export function lookupBuildingPopulation(table: BuildingPopulationTable, gersId: string): BuildingPopulation | null {
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
      const residents = residentsAt(table, mid);
      const bi = table.barangay[mid];
      const barangay = bi === 0xffff ? null : (table.meta.barangays[bi] ?? null);
      const shares = barangay ? table.meta.perBarangay[barangay]?.age_shares ?? {} : {};
      return {
        residents,
        barangay,
        byAge: table.meta.ageBands.map((band) => ({
          band,
          label: AGE_BAND_LABELS[band] ?? band,
          count: residents * (shares[band] ?? 0),
        })),
      };
    }
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

let cached: Promise<BuildingPopulationTable | null> | null = null;

/** Fetch once. Resolves null when the files are absent. */
export function loadBuildingPopulation(base: string): Promise<BuildingPopulationTable | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const [b, j] = await Promise.all([
          fetch(`${base}${placeFile('building_population.bin')}`),
          fetch(`${base}${placeFile('building_population.json')}`),
        ]);
        if (!b.ok || !j.ok) return null;
        return parseBuildingPopulation(await b.arrayBuffer(), (await j.json()) as BuildingPopulationMeta);
      } catch {
        return null;
      }
    })();
  }
  return cached;
}
