import fs from 'node:fs';
import { describe, it } from 'vitest';
import { parseMobilityBuildings, parseMobilityDataset } from '../utils/mobilityLoader';
import { CONGESTION_TUNING, MobilitySimulation } from '../utils/mobilitySim';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const RUN = process.env.BENCH === '1';

/** Headless benchmark of the real city. Run with: BENCH=1 npx vitest run src/__tests__/mobilityBench.test.ts */
describe.skipIf(!RUN)('mobility benchmark', () => {
  it('reports ms per step and trip statistics', () => {
    const dir = 'public/data/bacolod/';
    const meta = JSON.parse(fs.readFileSync(`${dir}mobility_zones.json`, 'utf-8'));
    const ds = parseMobilityDataset(ab(fs.readFileSync(`${dir}mobility_network.bin`)), meta);
    const side = JSON.parse(fs.readFileSync(`${dir}mobility_buildings.json`, 'utf-8'));
    ds.buildings = parseMobilityBuildings(
      ab(fs.readFileSync(`${dir}mobility_buildings.bin`)),
      side,
      ds.nZones,
      ds.nNodes
    );
    if (process.env.CRIT) CONGESTION_TUNING.critScale = Number(process.env.CRIT);
    for (const agents of (process.env.AGENTS ? [Number(process.env.AGENTS)] : [15000, 25000])) {
      const sim = new MobilitySimulation(ds, 7);
      const params: any = {
        targetAgents: agents, betaScale: 1, selectedBarangayName: null, barangayFilter: 'all',
        terrainEnabled: false, terrainExaggeration: 1, opacity: 1, congestionEnabled: process.env.CONG !== '0',
        congestionLoadScale: 1, colorMode: 'mode', gravityLambdaKm: Number(process.env.LAMBDA ?? 3), attrBlend: Number(process.env.BLEND ?? 0.5), gravityBalance: Number(process.env.BAL ?? 0.5),
        enabledModes: { walk: true, motorcycle: true, tricycle: true, car: true, puv: true },
      };
      sim.step(0.1, 100, 7.75, params); // warm-up spawn
      const t0 = performance.now();
      let s: any;
      for (let i = 0; i < 300; i++) s = sim.step(1 / 60, 10, 7.75, params);
      const ms = (performance.now() - t0) / 300;
      let km = 0, n = 0, intra = 0;
      for (let i = 0; i < agents; i++) {
        const info = sim.getAgentInfo(i, false, 1, true);
        if (!info) continue;
        n += 1; km += info.distanceKm;
        if (info.originZone === info.destZone) intra += 1;
      }
      console.log(
        `BENCH lam=${process.env.LAMBDA ?? 3} blend=${process.env.BLEND ?? 0.5} bal=${process.env.BAL ?? 0.5} agents=${agents} ms/step=${ms.toFixed(2)} meanTripKm=${(km / n).toFixed(2)} intraZone=${((100 * intra) / n).toFixed(1)}% tti=${s.travelTimeIndex.toFixed(2)} jam=${s.congestedEdgeCount} pax=${s.totalTravellers}`
      );
    }
  }, 600000);
});
