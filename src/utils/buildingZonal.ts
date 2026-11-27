/** Per-building BIR zonal value estimates (building_zonal.bin, written by
 *  scripts/estimate_building_zonal_values.py). Ids are sorted 16-byte UUIDs; lookup is a binary search. */

export const BUILDING_ZONAL_MAGIC = 0x4c565a42;

export interface BuildingValuationParams {
  note: string;
  coverage: Record<LandUseGroup, number>;
  costPerM2: Record<LandUseGroup, number>;
  costSource: string;
}

export type LandUseGroup = 'residential' | 'commercial' | 'industrial';

export interface BuildingZonalMeta {
  valuation?: BuildingValuationParams;
  streets: string[];
  tierLabels: string[];
  valueUnit: number;
  effectivity?: string;
  /** Buildings per estimate tier 1-4 (index 0 = tier 1). */
  tierCounts?: number[];
}

export interface BuildingZonalTable {
  n: number;
  ids: Uint8Array;
  values: Uint16Array;
  tiers: Uint8Array;
  streetIdx: Uint16Array;
  meta: BuildingZonalMeta;
}

export interface BuildingZonalEstimate {
  /** PHP per square metre (BIR tax floor, estimated). */
  value: number;
  /** 1 street in barangay, 2 street elsewhere, 3 barangay level. */
  tier: number;
  tierLabel: string;
  street: string | null;
  valuation: BuildingValuationParams | null;
}

const COMMERCIAL = new Set(['commercial', 'retail', 'supermarket', 'hotel', 'office', 'mixed_use']);
const INDUSTRIAL = new Set(['industrial', 'warehouse']);

export function landUseGroup(bclass: string | null | undefined): LandUseGroup {
  const c = (bclass ?? '').toLowerCase();
  if (COMMERCIAL.has(c)) return 'commercial';
  if (INDUSTRIAL.has(c)) return 'industrial';
  return 'residential';
}

export interface BuildingValueEstimate {
  lotAreaM2: number;
  landValue: number;
  structureValue: number;
  total: number;
  floors: number;
}

/**
 * Land = zonal value x lot area (footprint / coverage); structure = replacement cost
 * (footprint x floors x cost per m2). All inputs besides the zonal value are assumptions.
 */
export function estimateBuildingValue(
  est: BuildingZonalEstimate,
  bclass: string | null | undefined,
  footprintM2: number,
  floors: number | null
): BuildingValueEstimate | null {
  const v = est.valuation;
  if (!v || !(footprintM2 > 0)) return null;
  const g = landUseGroup(bclass);
  const nFloors = Math.max(1, Math.round(floors ?? 1));
  const lotAreaM2 = footprintM2 / v.coverage[g];
  const landValue = est.value * lotAreaM2;
  const structureValue = footprintM2 * nFloors * v.costPerM2[g];
  return { lotAreaM2, landValue, structureValue, total: landValue + structureValue, floors: nFloors };
}

export function parseBuildingZonal(buf: ArrayBuffer, meta: BuildingZonalMeta): BuildingZonalTable {
  const head = new Uint32Array(buf, 0, 4);
  if (head[0] !== BUILDING_ZONAL_MAGIC) throw new Error('Bad building_zonal.bin magic');
  const n = head[2];
  let o = 16;
  const ids = new Uint8Array(buf, o, n * 16);
  o += n * 16;
  const values = new Uint16Array(buf, o, n);
  o += n * 2;
  o += (4 - (o % 4)) % 4;
  const tiers = new Uint8Array(buf, o, n);
  o += n;
  o += (4 - (o % 4)) % 4;
  const streetIdx = new Uint16Array(buf, o, n);
  return { n, ids, values, tiers, streetIdx, meta };
}

function uuidBytes(id: string): Uint8Array | null {
  const hex = id.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function lookupBuildingZonal(
  table: BuildingZonalTable,
  gersId: string
): BuildingZonalEstimate | null {
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
      const tier = table.tiers[mid];
      const si = table.streetIdx[mid];
      return {
        value: table.values[mid] * table.meta.valueUnit,
        tier,
        tierLabel: table.meta.tierLabels[tier] ?? '',
        street: si === 0xffff ? null : (table.meta.streets[si] ?? null),
        valuation: table.meta.valuation ?? null,
      };
    }
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

let cached: Promise<BuildingZonalTable | null> | null = null;

/** Fetch once, on first building inspection. Resolves null when the files are absent. */
export function loadBuildingZonal(base: string): Promise<BuildingZonalTable | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const [b, j] = await Promise.all([
          fetch(`${base}data/bacolod/building_zonal.bin`),
          fetch(`${base}data/bacolod/building_zonal.json`),
        ]);
        if (!b.ok || !j.ok) return null;
        return parseBuildingZonal(await b.arrayBuffer(), (await j.json()) as BuildingZonalMeta);
      } catch {
        return null;
      }
    })();
  }
  return cached;
}
