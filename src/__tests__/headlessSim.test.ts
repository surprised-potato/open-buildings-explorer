import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

vi.mock('../utils/mobilityLoader', async () => {
  const actual = await vi.importActual<typeof import('../utils/mobilityLoader')>('../utils/mobilityLoader');
  return {
    ...actual,
    loadMobilityDataset: async () => {
      const dir = 'public/data/bacolod/';
      const meta = JSON.parse(fs.readFileSync(`${dir}mobility_zones.json`, 'utf-8'));
      const ds = actual.parseMobilityDataset(ab(fs.readFileSync(`${dir}mobility_network.bin`)), meta);
      ds.buildings = actual.parseMobilityBuildings(
        ab(fs.readFileSync(`${dir}mobility_buildings.bin`)),
        JSON.parse(fs.readFileSync(`${dir}mobility_buildings.json`, 'utf-8')),
        ds.nZones,
        ds.nNodes
      );
      return ds;
    },
  };
});

import { getBackgroundStats, getReportSimulation, isBackgroundRunning, runBackgroundSimulation } from '../reports/headlessSim';
import { aggregateTripGeneration } from '../reports/tripGeneration';
import { aggregateCorridors } from '../reports/corridors';

describe('background simulation for reports', () => {
  it('fills in tally, stats and corridor loads without a live simulation', async () => {
    expect(getReportSimulation()).toBeNull();
    const seen: number[] = [];
    const p = runBackgroundSimulation('/', (f) => seen.push(f));
    expect(isBackgroundRunning()).toBe(true);
    expect(runBackgroundSimulation('/')).toBe(p); // joins the run in progress
    await p;
    expect(isBackgroundRunning()).toBe(false);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);

    const r = getReportSimulation()!;
    expect(r.source).toBe('background');
    expect(getBackgroundStats()!.activeAgents).toBeGreaterThan(1000);

    const sim = r.sim;
    const snap = aggregateTripGeneration(sim.dataset.buildings!, sim.dataset.meta.zones.map((z) => z.name), sim.getTripTally());
    expect(snap.totalTrips).toBeGreaterThan(500);
    expect(snap.simHours).toBeGreaterThan(1.9);

    const streets = JSON.parse(fs.readFileSync('public/data/bacolod/mobility_edge_streets.json', 'utf-8'));
    const rows = aggregateCorridors(streets, sim.getEdgeLengthsKm(), sim.getEdgeLoad());
    expect(rows.reduce((s, x) => s + x.agents, 0)).toBeGreaterThan(500);
  }, 180000);
});
