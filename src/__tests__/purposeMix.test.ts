import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMobilityBuildings, parseMobilityDataset } from '../utils/mobilityLoader';
import { MobilitySimulation } from '../utils/mobilitySim';

const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

describe('trip purpose varies by origin barangay (real city)', () => {
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
    targetAgents: 9000, betaScale: 1, selectedBarangayName: null, barangayFilter: 'all',
    terrainEnabled: false, terrainExaggeration: 1, opacity: 1, congestionEnabled: false,
    congestionLoadScale: 1, colorMode: 'mode', gravityLambdaKm: 3, attrBlend: 0.5, gravityBalance: 0.5,
    enabledModes: { walk: true, motorcycle: true, tricycle: true, car: true, puv: true },
  };

  it('zones carry age-based production and area types', () => {
    const withProd = meta.zones.filter((z: any) => z.prod);
    expect(withProd.length).toBeGreaterThanOrEqual(60);
    expect(meta.zones.some((z: any) => z.area_type?.key === 'core')).toBe(true);
    const share = (p: string) => withProd.reduce((s: number, z: any) => s + z.prod[p], 0) /
      withProd.reduce((s: number, z: any) => s + z.prod.hbw + z.prod.hbe + z.prod.hbo, 0);
    expect(share('hbw')).toBeCloseTo(0.48, 2);
    expect(share('hbe')).toBeCloseTo(0.35, 2);
  });

  it('production CDF per purpose equals the age model exactly', async () => {
    const { buildGravityModel } = await import('../utils/mobilitySim');
    const gm = buildGravityModel(ds.meta, 1, 3, 0.5)!;
    for (const pid of ['hbw', 'hbe', 'hbo'] as const) {
      const cdf = gm.prodCdf[pid];
      const sum = ds.meta.zones.reduce((a, z: any) => a + (z.prod?.[pid] ?? 0), 0);
      const withProd = ds.meta.zones.filter((z: any) => z.prod).length;
      expect(withProd).toBeGreaterThanOrEqual(60);
      for (const i of [0, 10, 30]) {
        const z: any = ds.meta.zones[i];
        if (!z.prod) continue;
        const p = cdf[i] - (i > 0 ? cdf[i - 1] : 0);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeCloseTo(z.prod[pid] / sum, 2);
      }
    }
    // The three purposes have different spatial patterns.
    const e = gm.prodCdf.hbe;
    const w = gm.prodCdf.hbw;
    expect(Array.from(e).some((v, i) => Math.abs(v - w[i]) > 0.001)).toBe(true);
  });

  it('simulated purpose mix by origin follows the model and keeps city shares', () => {
    const sim = new MobilitySimulation(ds, 5);
    const counts = ds.meta.zones.map(() => [0, 0, 0]);
    const zoneIdx = new Map(ds.meta.zones.map((zz, i) => [zz.name, i] as const));
    for (let step = 0; step < 3500; step += 1) {
      sim.step(1 / 30, 60, 7.75, params);
      if (step > 300 && step % 25 === 0) {
        for (let i = 0; i < 9000; i += 1) {
          const info = sim.getAgentInfo(i, false, 1, true);
          if (!info) continue;
          const homeName = info.originBuilding?.role === 'home' ? info.originZone : info.destZone;
          const z = zoneIdx.get(homeName) ?? -1;
          const p = info.purpose === 'hbw' ? 0 : info.purpose === 'hbe' ? 1 : 2;
          if (z >= 0) counts[z][p] += 1;
        }
      }
    }
    const tot = counts.reduce((s, c) => s + c[0] + c[1] + c[2], 0);
    const city = [0, 1, 2].map((p) => counts.reduce((s, c) => s + c[p], 0) / tot);
    expect(city[0]).toBeGreaterThan(0.42);
    expect(city[0]).toBeLessThan(0.54);
    expect(city[1]).toBeGreaterThan(0.29);
    expect(city[1]).toBeLessThan(0.41);

    const idx = ds.meta.zones.map((_z, i) => i).filter((i) => ds.meta.zones[i].purpose_mix && counts[i][0] + counts[i][1] + counts[i][2] > 400);
    const simHbe = idx.map((i) => counts[i][1] / (counts[i][0] + counts[i][1] + counts[i][2]));
    const modelHbe = idx.map((i) => ds.meta.zones[i].purpose_mix!.hbe);
    const r = pearson(simHbe, modelHbe);
    console.log(`purpose mix: ${idx.length} zones, corr(sim HBE, model HBE)=${r.toFixed(2)}, sim HBE range ${Math.min(...simHbe).toFixed(2)}-${Math.max(...simHbe).toFixed(2)}`);
    expect(Math.max(...simHbe) - Math.min(...simHbe)).toBeGreaterThan(0.08);
    // Snapshots of in-flight agents are correlated and a zone has only a few hundred samples, so this
    // is a sanity bound; the exact check is the production CDF test above.
    expect(r).toBeGreaterThan(0.3);
  }, 300000);
});
