import { describe, expect, it } from 'vitest';
import {
  BUILDING_POPULATION_MAGIC,
  idAt,
  lookupBuildingPopulation,
  parseBuildingPopulation,
  residentsAt,
  type BuildingPopulationMeta,
} from '../utils/buildingPopulation';

const meta: BuildingPopulationMeta = {
  source: 'test',
  method: 'test',
  note: 'test',
  residentScale: 10,
  barangays: ['Alpha', 'Beta'],
  ageBands: ['age_0_4', 'age_5_14', 'age_15_24', 'age_25_59', 'age_60_plus'],
  surgeLabels: [],
  perBarangay: {
    Alpha: { population: 10, buildings: 2, buildings_with_residents: 2, surge_residents: [10, 0, 0, 0, 0],
      age_shares: { age_0_4: 0.1, age_5_14: 0.2, age_15_24: 0.2, age_25_59: 0.4, age_60_plus: 0.1 } },
    Beta: { population: 0, buildings: 0, buildings_with_residents: 0, surge_residents: [0, 0, 0, 0, 0], age_shares: {} },
  },
  population: 10,
  placed: 10,
  unplacedPopulation: 0,
};

/** Two buildings with ids 00..01 and 00..02 (sorted), 6.5 and 3.5 residents, both in Alpha. */
function fixture(): ArrayBuffer {
  const n = 2;
  const buf = new ArrayBuffer(16 + n * 16 + n * 4);
  new Uint32Array(buf, 0, 4).set([BUILDING_POPULATION_MAGIC, 1, n, 10]);
  const ids = new Uint8Array(buf, 16, n * 16);
  ids[15] = 1;
  ids[31] = 2;
  const tail = new DataView(buf, 16 + n * 16);
  tail.setUint16(0, 65, true);
  tail.setUint16(2, 35, true);
  tail.setUint16(4, 0, true);
  tail.setUint16(6, 0, true);
  return buf;
}

describe('building population table', () => {
  it('parses, formats ids and finds buildings by id', () => {
    const t = parseBuildingPopulation(fixture(), meta);
    expect(t.n).toBe(2);
    expect(idAt(t, 1)).toBe('00000000-0000-0000-0000-000000000002');
    expect(residentsAt(t, 0)).toBeCloseTo(6.5);
    const hit = lookupBuildingPopulation(t, '00000000-0000-0000-0000-000000000002')!;
    expect(hit.residents).toBeCloseTo(3.5);
    expect(hit.barangay).toBe('Alpha');
    expect(hit.byAge.find((a) => a.band === 'age_60_plus')!.count).toBeCloseTo(0.35);
    expect(lookupBuildingPopulation(t, '00000000-0000-0000-0000-000000000009')).toBeNull();
    expect(lookupBuildingPopulation(t, 'not-a-uuid')).toBeNull();
  });
});
