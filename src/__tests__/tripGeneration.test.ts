import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateTripGeneration, buildGersIndex, gersKey, landUseOfClass } from '../reports/tripGeneration';
import { parseMobilityBuildings, parseMobilityDataset } from '../utils/mobilityLoader';
import { MobilitySimulation } from '../utils/mobilitySim';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('trip generation tally (real city)', () => {
  const dir = 'public/data/bacolod/';
  const meta = JSON.parse(fs.readFileSync(`${dir}mobility_zones.json`, 'utf-8'));
  const ds = parseMobilityDataset(ab(fs.readFileSync(`${dir}mobility_network.bin`)), meta);
  ds.buildings = parseMobilityBuildings(
    ab(fs.readFileSync(`${dir}mobility_buildings.bin`)),
    JSON.parse(fs.readFileSync(`${dir}mobility_buildings.json`, 'utf-8')),
    ds.nZones,
    ds.nNodes
  );
  const params: any = {
    targetAgents: 3000, betaScale: 1, selectedBarangayName: null, barangayFilter: 'all',
    terrainEnabled: false, terrainExaggeration: 1, opacity: 1, congestionEnabled: true,
    congestionLoadScale: 1, colorMode: 'mode', gravityLambdaKm: 3, attrBlend: 0.5, gravityBalance: 0.5,
    enabledModes: { walk: true, motorcycle: true, tricycle: true, car: true, puv: true },
  };

  it('counts each trip once out and once in, by building, land use and campus', () => {
    const sim = new MobilitySimulation(ds, 11);
    for (let i = 0; i < 1500; i += 1) sim.step(1 / 30, 60, 7.75, params);
    const tally = sim.getTripTally();
    const sumOut = tally.out.reduce((a, b) => a + b, 0);
    const sumIn = tally.in.reduce((a, b) => a + b, 0);
    expect(sumOut).toBeGreaterThan(100);
    expect(sumIn).toBe(sumOut); // every spawn has both a building origin and destination
    expect(tally.simSec).toBeGreaterThan(0);

    const snap = aggregateTripGeneration(ds.buildings!, ds.meta.zones.map((z) => z.name), tally);
    expect(snap.totalTrips).toBe(sumOut);
    expect(snap.landUse.reduce((s, l) => s + l.out, 0)).toBe(sumOut);
    expect(snap.landUse.reduce((s, l) => s + l.buildings, 0)).toBe(ds.buildings!.count);
    expect(snap.topAttractors[0].in).toBeGreaterThanOrEqual(snap.topAttractors[1].in);
    expect(snap.landUse.find((l) => l.group === 'Residential')!.out).toBeGreaterThan(0);

    sim.resetTripTally();
    expect(sim.getTripTally().out.reduce((a, b) => a + b, 0)).toBe(0);
  }, 120000);

  it('maps GERS ids to building rows and classifies land use', () => {
    const idx = buildGersIndex(ds.buildings!);
    expect(idx.size).toBe(ds.buildings!.count);
    expect(gersKey('ABCDEF01-0000-0000-0000-000000000000')).toBe('abcdef01000000000000000000000000');
    expect(landUseOfClass('university')).toBe('Education');
    expect(landUseOfClass('house')).toBe('Residential');
    expect(landUseOfClass('weird')).toBe('Other');
  });
});
