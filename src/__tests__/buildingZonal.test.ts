import { describe, expect, it } from 'vitest';
import { BUILDING_ZONAL_MAGIC, lookupBuildingZonal, parseBuildingZonal } from '../utils/buildingZonal';

function build(ids: string[], values: number[], tiers: number[], streets: number[]): ArrayBuffer {
  const n = ids.length;
  const pad = (x: number) => (4 - (x % 4)) % 4;
  const tOff = 16 + n * 16 + n * 2;
  const tPad = pad(tOff);
  const sOff = tOff + tPad + n + pad(n);
  const buf = new ArrayBuffer(sOff + n * 2 + pad(n * 2));
  new Uint32Array(buf, 0, 4).set([BUILDING_ZONAL_MAGIC, 1, n, 1]);
  const b = new Uint8Array(buf);
  ids.forEach((id, i) => {
    const hex = id.replace(/-/g, '');
    for (let k = 0; k < 16; k += 1) b[16 + i * 16 + k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
  });
  new Uint16Array(buf, 16 + n * 16, n).set(values);
  b.set(tiers, tOff + tPad);
  new Uint16Array(buf, sOff, n).set(streets);
  return buf;
}

describe('building zonal lookup', () => {
  const a = '00000000-0000-0000-0000-000000000002';
  const c = '00000000-0000-0000-0000-000000000009';
  const buf = build([a, c], [200, 10], [1, 3], [0, 0xffff]);
  const t = parseBuildingZonal(buf, { streets: ['LACSON ST'], tierLabels: ['', 'street', 'x', 'barangay'], valueUnit: 5 });

  it('finds estimates by id', () => {
    expect(lookupBuildingZonal(t, a)).toMatchObject({ value: 1000, tier: 1, street: 'LACSON ST' });
    expect(lookupBuildingZonal(t, c)).toMatchObject({ value: 50, tier: 3, street: null });
  });
  it('returns null for unknown or malformed ids', () => {
    expect(lookupBuildingZonal(t, '00000000-0000-0000-0000-000000000005')).toBeNull();
    expect(lookupBuildingZonal(t, 'nope')).toBeNull();
  });
});

import { estimateBuildingValue } from '../utils/buildingZonal';

describe('building value estimate', () => {
  const val = {
    note: '',
    costSource: '',
    coverage: { residential: 0.5, commercial: 0.8, industrial: 0.6 },
    costPerM2: { residential: 10000, commercial: 15000, industrial: 8000 },
  };
  const est = { value: 2000, tier: 3, tierLabel: '', street: null, valuation: val };
  it('adds land (footprint/coverage x zonal) and structure (footprint x floors x cost)', () => {
    const r = estimateBuildingValue(est, 'house', 100, 2)!;
    expect(r.lotAreaM2).toBe(200);
    expect(r.landValue).toBe(400000);
    expect(r.structureValue).toBe(2_000_000);
    expect(r.total).toBe(2_400_000);
  });
  it('uses commercial parameters and needs a footprint', () => {
    expect(estimateBuildingValue(est, 'retail', 80, null)!.structureValue).toBe(1_200_000);
    expect(estimateBuildingValue(est, 'house', 0, 1)).toBeNull();
  });
});
