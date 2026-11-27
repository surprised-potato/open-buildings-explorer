import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lookupBuildingHazard, parseBuildingHazard, type BuildingHazardMeta } from '../utils/buildingHazard';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('building hazard table', () => {
  const dir = 'public/data/bacolod/';
  const meta = JSON.parse(readFileSync(`${dir}building_hazard.json`, 'utf8')) as BuildingHazardMeta;
  const table = parseBuildingHazard(ab(readFileSync(`${dir}building_hazard.bin`)), meta);

  it('matches the zonal table building ids and decodes flags', () => {
    const zonal = JSON.parse(readFileSync(`${dir}building_zonal.json`, 'utf8'));
    expect(table.n).toBe(zonal.buildings);
    // every stored value fits the documented bits: surge 0-4 plus the low-lying bit
    for (let i = 0; i < table.n; i += 977) expect((table.values[i] & 7) <= 4).toBe(true);
    const hex = (i: number) =>
      Array.from(table.ids.slice(i * 16, i * 16 + 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const id = (i: number) => hex(i).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const h = lookupBuildingHazard(table, id(1234))!;
    expect(h.surgeLevel).toBe(table.values[1234] & 7);
    expect(h.lowLying).toBe((table.values[1234] & 8) !== 0);
    expect(h.surgeLabel).toBe(meta.surgeLabels[h.surgeLevel]);
    expect(lookupBuildingHazard(table, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('city counts agree with the per-barangay aggregate', () => {
    const prop = JSON.parse(readFileSync(`${dir}barangay_property.json`, 'utf8'));
    let reached = 0;
    for (let i = 0; i < table.n; i += 1) if ((table.values[i] & 7) > 0) reached += 1;
    const agg = (Object.values(prop.barangays) as Array<{ surge: number[] }>).reduce(
      (s, b) => s + b.surge.slice(1).reduce((x, y) => x + y, 0),
      0
    );
    expect(reached).toBe(agg);
  });
});
