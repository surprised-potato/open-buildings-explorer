import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMobilityDataset } from '../utils/mobilityLoader';
import { NO_EDGE, TreeSolver, buildOutAdjacency } from '../utils/routeTrees';

describe('TreeSolver', () => {
  // 0->1 (1), 1->2 (1), 0->2 (5): shortest 0->2 is via 1 until 0->1 gets expensive.
  const src = [0, 1, 0];
  const dst = [1, 2, 2];
  const solver = new TreeSolver(3, 3, buildOutAdjacency(3, src, 3), dst);

  it('finds shortest arrivals and marks the root', () => {
    const prev = new Uint16Array(3);
    solver.solve(0, [1, 1, 5], Infinity, prev, 0);
    expect(Array.from(prev)).toEqual([NO_EDGE, 0, 1]);
  });

  it('reroutes when a link gets expensive and skips banned edges', () => {
    const prev = new Uint16Array(3);
    solver.solve(0, [10, 1, 5], Infinity, prev, 0);
    expect(prev[2]).toBe(2);
    solver.solve(0, [1, 1, 5], 5, prev, 0); // 0->2 banned (weight >= 5)
    expect(prev[2]).toBe(1);
  });
});

describe('live rerouting on the real network', () => {
  const dir = 'public/data/bacolod/';
  const have = fs.existsSync(`${dir}mobility_network.bin`);
  it.skipIf(!have)('matches the exported tree cost and detours around a jam', () => {
    const b = fs.readFileSync(`${dir}mobility_network.bin`);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const meta = JSON.parse(fs.readFileSync(`${dir}mobility_zones.json`, 'utf-8'));
    const ds = parseMobilityDataset(ab, meta);
    const solver = new TreeSolver(ds.nNodes, ds.nEdges, buildOutAdjacency(ds.nNodes, ds.edgeSrc, ds.nEdges), ds.edgeDst);
    const car = ds.edgeT0Sec.subarray(3 * ds.nEdges, 4 * ds.nEdges);
    const zi = meta.zones.findIndex((z: { name: string }) => z.name === 'Granada');
    const ti = meta.zones.findIndex((z: { name: string }) => z.name === 'Barangay 18');
    const hub = meta.zones[zi].hub_node;
    const target = meta.zones[ti].hub_node;
    const cost = (prev: Uint16Array, w: ArrayLike<number>) => {
      let c = 0;
      const used: number[] = [];
      for (let n = target; n !== hub; ) {
        const e = prev[n];
        expect(e).not.toBe(NO_EDGE);
        used.push(e);
        c += w[e];
        n = ds.edgeSrc[e];
      }
      return { c, used };
    };
    const prev = new Uint16Array(ds.nNodes);
    solver.solve(hub, car, 1e6, prev, 0);
    const base = cost(prev, car);
    const staticPrev = ds.fromHubPrevEdge.subarray(zi * ds.nNodes, (zi + 1) * ds.nNodes);
    expect(base.c).toBeCloseTo(cost(staticPrev as Uint16Array, car).c, 1);

    // Jam the 5 longest edges on the free-flow route: the new route avoids them and costs more.
    const jammed = base.used.sort((a, b) => ds.edgeLenKm[b] - ds.edgeLenKm[a]).slice(0, 5);
    const w = Float32Array.from(car);
    for (const e of jammed) w[e] *= 8;
    solver.solve(hub, w, 1e6, prev, 0);
    const detour = cost(prev, w);
    expect(detour.used.some((e) => jammed.includes(e))).toBe(false);
    expect(detour.c).toBeGreaterThan(base.c);
  });
});
